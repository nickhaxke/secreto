-- Paste into the existing Supabase project's SQL Editor and run once.
-- Never expose the private schema through PostgREST's exposed schemas.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS secreto_private;
REVOKE ALL ON SCHEMA secreto_private FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE secreto_private.admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE TABLE secreto_private.events (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  exchange_date date NOT NULL,
  budget integer NOT NULL CHECK (budget BETWEEN 0 AND 100000000),
  currency text NOT NULL CHECK (currency='TZS'),
  drawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE secreto_private.participants (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES secreto_private.events(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  normalized_name text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  pin_hash text NOT NULL,
  recipient_id uuid,
  opened_at timestamptz,
  revealed_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  UNIQUE(event_id,normalized_name),
  UNIQUE(event_id,id),
  UNIQUE(event_id,recipient_id),
  CHECK (recipient_id IS NULL OR recipient_id<>id),
  FOREIGN KEY(event_id,recipient_id) REFERENCES secreto_private.participants(event_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX participants_event_idx ON secreto_private.participants(event_id);
CREATE TABLE secreto_private.participant_sessions (
  session_hash text PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  participant_id uuid NOT NULL REFERENCES secreto_private.participants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX participant_sessions_expiry_idx ON secreto_private.participant_sessions(expires_at);
ALTER TABLE secreto_private.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE secreto_private.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE secreto_private.participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE secreto_private.participant_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA secreto_private FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION secreto_private.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$ SELECT EXISTS(SELECT 1 FROM secreto_private.admins WHERE user_id=auth.uid()) $$;
REVOKE ALL ON FUNCTION secreto_private.is_admin() FROM PUBLIC,anon,authenticated,service_role;

-- Uniform cryptographic integer in [0, upper_bound), using rejection sampling.
CREATE FUNCTION secreto_private.random_index(upper_bound integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $$
DECLARE bytes bytea; value bigint; ceiling bigint;
BEGIN
 IF upper_bound<1 THEN RAISE EXCEPTION 'Invalid random range'; END IF;
 ceiling := (4294967296::bigint / upper_bound) * upper_bound;
 LOOP
   bytes := extensions.gen_random_bytes(4);
   value := get_byte(bytes,0)::bigint*16777216 + get_byte(bytes,1)::bigint*65536 + get_byte(bytes,2)::bigint*256 + get_byte(bytes,3)::bigint;
   IF value<ceiling THEN RETURN (value % upper_bound)::integer; END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION secreto_private.random_index(integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.secreto_event_list() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$ DECLARE result jsonb; BEGIN
 IF NOT secreto_private.is_admin() THEN RAISE EXCEPTION 'Organizer access required' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,'exchange_date',e.exchange_date,'budget',e.budget,'currency',e.currency,'drawn_at',e.drawn_at,'total',s.total,'opened',s.opened,'revealed',s.revealed,'pending',s.total-s.opened,'completion',CASE WHEN s.total=0 THEN 0 ELSE round(100.0*s.revealed/s.total)::integer END) ORDER BY e.created_at DESC),'[]'::jsonb)
 INTO result FROM secreto_private.events e CROSS JOIN LATERAL (SELECT count(*)::integer total,count(p.opened_at)::integer opened,count(p.revealed_at)::integer revealed FROM secreto_private.participants p WHERE p.event_id=e.id) s;
 RETURN result;
END $$;

CREATE FUNCTION public.secreto_event_create(p_name text,p_exchange_date date,p_budget integer,p_currency text,p_people jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ DECLARE eid uuid; person jsonb; nm text; norm text; BEGIN
 IF NOT secreto_private.is_admin() THEN RAISE EXCEPTION 'Organizer access required' USING ERRCODE='42501'; END IF;
 IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 80 OR p_exchange_date<current_date OR p_budget NOT BETWEEN 0 AND 100000000 OR p_currency<>'TZS' THEN RAISE EXCEPTION 'Event details are invalid'; END IF;
 IF jsonb_typeof(p_people)<>'array' OR jsonb_array_length(p_people) NOT BETWEEN 2 AND 100 THEN RAISE EXCEPTION 'Add 2 to 100 participants'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_people) x WHERE jsonb_typeof(x)<>'object' OR coalesce(x->>'name','')='' OR length(x->>'name')>80 OR coalesce(x->>'token','') !~ '^[a-f0-9]{64}$' OR coalesce(x->>'pin','') !~ '^[0-9]{6}$') THEN RAISE EXCEPTION 'Participant details are invalid'; END IF;
 IF (SELECT count(DISTINCT lower(btrim(x->>'name'))) FROM jsonb_array_elements(p_people) x)<>jsonb_array_length(p_people) THEN RAISE EXCEPTION 'Participant names must be unique'; END IF;
 INSERT INTO secreto_private.events(name,exchange_date,budget,currency) VALUES(btrim(p_name),p_exchange_date,p_budget,p_currency) RETURNING id INTO eid;
 FOR person IN SELECT value FROM jsonb_array_elements(p_people) LOOP
  nm:=btrim(regexp_replace(person->>'name','\s+',' ','g')); norm:=lower(nm);
  INSERT INTO secreto_private.participants(event_id,name,normalized_name,token_hash,pin_hash) VALUES(eid,nm,norm,encode(extensions.digest(convert_to(person->>'token','UTF8'),'sha256'),'hex'),extensions.crypt(person->>'pin',extensions.gen_salt('bf',12)));
 END LOOP;
 RETURN jsonb_build_object('id',eid,'name',btrim(p_name),'exchange_date',p_exchange_date,'budget',p_budget,'currency',p_currency);
END $$;

CREATE FUNCTION public.secreto_event_get(p_event_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$ DECLARE result jsonb; BEGIN
 IF NOT secreto_private.is_admin() THEN RAISE EXCEPTION 'Organizer access required' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('event',jsonb_build_object('id',e.id,'name',e.name,'exchange_date',e.exchange_date,'budget',e.budget,'currency',e.currency,'drawn_at',e.drawn_at,'total',s.total,'opened',s.opened,'revealed',s.revealed,'pending',s.total-s.opened,'completion',CASE WHEN s.total=0 THEN 0 ELSE round(100.0*s.revealed/s.total)::integer END),'participants',s.people)
 INTO result FROM secreto_private.events e CROSS JOIN LATERAL (SELECT count(*)::integer total,count(p.opened_at)::integer opened,count(p.revealed_at)::integer revealed,coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'status',CASE WHEN p.revealed_at IS NOT NULL THEN 'Revealed' WHEN p.opened_at IS NOT NULL THEN 'Opened' ELSE 'Pending' END) ORDER BY p.normalized_name),'[]'::jsonb) people FROM secreto_private.participants p WHERE p.event_id=e.id) s WHERE e.id=p_event_id;
 IF result IS NULL THEN RAISE EXCEPTION 'Event not found' USING ERRCODE='P0002'; END IF; RETURN result;
END $$;

CREATE FUNCTION public.secreto_event_draw(p_event_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ DECLARE ids uuid[]; shuffled uuid[]; n integer; i integer; j integer; hold uuid; BEGIN
 IF NOT secreto_private.is_admin() THEN RAISE EXCEPTION 'Organizer access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM secreto_private.events WHERE id=p_event_id AND drawn_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Event not found or draw already complete' USING ERRCODE='40001'; END IF;
 PERFORM 1 FROM secreto_private.participants WHERE event_id=p_event_id FOR UPDATE;
 SELECT array_agg(id ORDER BY id) INTO ids FROM secreto_private.participants WHERE event_id=p_event_id;
 n:=coalesce(array_length(ids,1),0); IF n<2 THEN RAISE EXCEPTION 'Add at least two participants'; END IF;
 LOOP
  shuffled:=ids;
  FOR i IN REVERSE n..2 LOOP j:=secreto_private.random_index(i)+1; hold:=shuffled[i]; shuffled[i]:=shuffled[j]; shuffled[j]:=hold; END LOOP;
  EXIT WHEN NOT EXISTS(SELECT 1 FROM generate_subscripts(ids,1) AS x(i) WHERE ids[x.i]=shuffled[x.i]);
 END LOOP;
 FOR i IN 1..n LOOP UPDATE secreto_private.participants SET recipient_id=shuffled[i] WHERE id=ids[i]; END LOOP;
 UPDATE secreto_private.events SET drawn_at=now() WHERE id=p_event_id;
 RETURN true;
END $$;

CREATE FUNCTION public.secreto_invitation_open(p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ DECLARE result jsonb; BEGIN
 IF p_token !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invitation not found'; END IF;
 UPDATE secreto_private.participants p SET opened_at=coalesce(opened_at,now()) FROM secreto_private.events e WHERE p.event_id=e.id AND p.token_hash=encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex') RETURNING jsonb_build_object('name',e.name,'exchange_date',e.exchange_date,'budget',e.budget,'currency',e.currency) INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'Invitation not found'; END IF; RETURN result;
END $$;

CREATE FUNCTION public.secreto_invitation_verify(p_token text,p_pin text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ DECLARE p secreto_private.participants%ROWTYPE; ticket text; h text; BEGIN
 IF p_token !~ '^[a-f0-9]{64}$' OR p_pin !~ '^[0-9]{6}$' THEN RETURN jsonb_build_object('ok',false,'message','PIN si sahihi au imeisha muda.'); END IF;
 SELECT * INTO p FROM secreto_private.participants WHERE token_hash=encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex') FOR UPDATE;
 IF NOT FOUND OR (p.locked_until IS NOT NULL AND p.locked_until>now()) THEN RETURN jsonb_build_object('ok',false,'message','PIN si sahihi au umejaribu mara nyingi.'); END IF;
 IF extensions.crypt(p_pin,p.pin_hash)<>p.pin_hash THEN
  UPDATE secreto_private.participants SET failed_attempts=CASE WHEN failed_attempts>=4 THEN 0 ELSE failed_attempts+1 END,locked_until=CASE WHEN failed_attempts>=4 THEN now()+interval '15 minutes' ELSE NULL END WHERE id=p.id;
  RETURN jsonb_build_object('ok',false,'message','PIN si sahihi.');
 END IF;
 UPDATE secreto_private.participants SET failed_attempts=0,locked_until=NULL,opened_at=coalesce(opened_at,now()) WHERE id=p.id;
 DELETE FROM secreto_private.participant_sessions WHERE participant_id=p.id;
 ticket:=encode(extensions.gen_random_bytes(32),'hex'); h:=encode(extensions.digest(convert_to(ticket,'UTF8'),'sha256'),'hex');
 INSERT INTO secreto_private.participant_sessions(session_hash,participant_id,expires_at) VALUES(h,p.id,now()+interval '30 minutes');
 RETURN jsonb_build_object('ok',true,'session',ticket);
END $$;

CREATE FUNCTION public.secreto_invitation_reveal(p_session text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ DECLARE result jsonb; BEGIN
 IF p_session !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Mwaliko umeisha. Weka PIN tena.'; END IF;
 SELECT jsonb_build_object('recipient',r.name) INTO result FROM secreto_private.participant_sessions s JOIN secreto_private.participants p ON p.id=s.participant_id JOIN secreto_private.participants r ON r.id=p.recipient_id WHERE s.session_hash=encode(extensions.digest(convert_to(p_session,'UTF8'),'sha256'),'hex') AND s.expires_at>now() FOR UPDATE OF s,p;
 IF result IS NULL THEN RAISE EXCEPTION 'Mwaliko umeisha au draw haijafanyika.'; END IF;
 UPDATE secreto_private.participants SET revealed_at=coalesce(revealed_at,now()) WHERE id=(SELECT participant_id FROM secreto_private.participant_sessions WHERE session_hash=encode(extensions.digest(convert_to(p_session,'UTF8'),'sha256'),'hex'));
 RETURN result;
END $$;

CREATE FUNCTION public.secreto_invitation_replace(p_event_id uuid,p_participant_id uuid,p_token text,p_pin text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ BEGIN
 IF NOT secreto_private.is_admin() THEN RAISE EXCEPTION 'Organizer access required' USING ERRCODE='42501'; END IF;
 IF p_token !~ '^[a-f0-9]{64}$' OR p_pin !~ '^[0-9]{6}$' THEN RAISE EXCEPTION 'Invitation credentials are invalid'; END IF;
 UPDATE secreto_private.participants p SET token_hash=encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex'),pin_hash=extensions.crypt(p_pin,extensions.gen_salt('bf',12)),failed_attempts=0,locked_until=NULL FROM secreto_private.events e WHERE p.event_id=e.id AND p.event_id=p_event_id AND p.id=p_participant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Participant not found'; END IF;
 DELETE FROM secreto_private.participant_sessions WHERE participant_id=p_participant_id; RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.secreto_event_list() FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.secreto_event_create(text,date,integer,text,jsonb) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.secreto_event_get(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.secreto_event_draw(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.secreto_invitation_replace(uuid,uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.secreto_event_list() TO authenticated;
GRANT EXECUTE ON FUNCTION public.secreto_event_create(text,date,integer,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.secreto_event_get(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.secreto_event_draw(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.secreto_invitation_replace(uuid,uuid,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.secreto_invitation_open(text) FROM PUBLIC,authenticated;
REVOKE ALL ON FUNCTION public.secreto_invitation_verify(text,text) FROM PUBLIC,authenticated;
REVOKE ALL ON FUNCTION public.secreto_invitation_reveal(text) FROM PUBLIC,authenticated;
GRANT EXECUTE ON FUNCTION public.secreto_invitation_open(text) TO anon;
GRANT EXECUTE ON FUNCTION public.secreto_invitation_verify(text,text) TO anon;
GRANT EXECUTE ON FUNCTION public.secreto_invitation_reveal(text) TO anon;
COMMIT;
NOTIFY pgrst,'reload schema';
