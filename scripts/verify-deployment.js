const base = new URL(process.argv[2] || 'https://secreto-drnick.netlify.app');
if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
  throw new Error('Deployment verification requires HTTPS outside localhost.');
}
try {
  const home = await fetch(new URL('/', base), {signal:AbortSignal.timeout(20000)});
  if (!home.ok || !(await home.text()).includes('<title>Secreto')) {
    throw new Error(`Homepage check failed (HTTP ${home.status}).`);
  }
  const session = await fetch(new URL('/api/session', base), {
    signal:AbortSignal.timeout(20000), redirect:'error', headers:{Accept:'application/json'},
  });
  if (!session.headers.get('content-type')?.includes('application/json')) {
    throw new Error(`API returned HTTP ${session.status} without JSON. Verify function deployment and routing; a static-only deployment cannot run Secreto.`);
  }
  if (!session.ok) {
    throw new Error(`API returned HTTP ${session.status}. Review Functions configuration and database connectivity in Netlify.`);
  }
  const body = await session.json();
  if (body.role !== null) throw new Error('Unexpected anonymous session response.');
  console.log('Passed: Secreto homepage and unauthenticated production API respond correctly.');
  console.log('Organizer login, database writes, draw, and private reveal still require authenticated end-to-end verification.');
} catch (error) {
  console.error(`Deployment verification failed: ${error.message}`);
  process.exitCode = 1;
}
