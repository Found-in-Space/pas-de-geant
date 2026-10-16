import { createServer } from 'node:http';
import { createOpenAIVoiceTokenMiddleware } from '@found-in-space/voice-os/server/openai';
import { geantAiCapabilities } from '@found-in-space/pas-de-geant';
// Explicit local example. The hosting application supplies its own production authorization policy.
const origin = process.env.GEANT_AI_ALLOWED_ORIGIN;
if (!origin) throw new Error('Set GEANT_AI_ALLOWED_ORIGIN to the exact example-page origin.');
const configuration = { session: { type: 'realtime', model: 'gpt-realtime-2.1',
  instructions: 'Use get_state for live viewer facts. Use the installed controls only. Coordinates refer to the focused body in degrees; scale is 1:N. Distinguish reference surfaces from measured terrain. No geocoding service is installed.' } };
const profile = bodies => ({ tools: geantAiCapabilities(bodies).map(capability => capability.contract), configuration });
const token = createOpenAIVoiceTokenMiddleware({ path: '/token', apiKey: process.env.OPENAI_API_KEY,
  authorize: request => request.headers.get('origin') === origin,
  profiles: { 'geant-earth': profile(['earth']), 'geant-moon': profile(['moon']), 'geant-earth-moon': profile(['earth', 'moon']) },
});
const server = createServer((request, response) => {
  if (request.headers.origin === origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'OPTIONS' && request.headers.origin === origin) { response.setHeader('Access-Control-Allow-Methods', 'POST'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type'); response.writeHead(204).end(); return; }
  void token(request, response, () => { response.writeHead(404).end(); }).catch(error => { console.error(error); response.writeHead(500).end('Token issuance failed.'); });
});
server.listen(Number(process.env.GEANT_AI_PORT ?? 4212), '127.0.0.1', () => console.log('Local Geant token example listening on loopback.'));
