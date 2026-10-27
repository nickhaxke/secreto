SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2;
SELECT schemaname, tablename, rowsecurity FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2;
SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check FROM pg_policies ORDER BY 1,2;
SELECT n.nspname, p.proname, p.prosecdef, p.proacl, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','secreto_v2') AND p.prokind='f';
SELECT table_schema,table_name,grantee,privilege_type FROM information_schema.role_table_grants WHERE table_schema IN ('public','secreto_v2') ORDER BY 1,2,3;
SELECT schemaname,tablename,indexdef FROM pg_indexes WHERE schemaname IN ('public','secreto_v2');
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('public','secreto_v2'));
