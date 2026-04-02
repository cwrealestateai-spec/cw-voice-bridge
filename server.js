import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const fastify = Fastify({ logger: true });

await fastify.register(websocket);

// Add content type parser for Twilio's form data
fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, function (req, body, done) {
  try {
    const parsed = new URLSearchParams(body);
    const result = {};
    for (const [key, value] of parsed) {
      result[key] = value;
    }
    done(null, result);
  } catch (err) {
    done(err, undefined);
  }
});

// Config
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'iP95p4xoKVk53GoZ742B';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://100.123.26.118:18789';
const FROM_NUMBER = process.env.FROM_NUMBER || '+18147783188';

const ALLOWED_NUMBERS = ['+2348182459983', '+2349160009729', '+2347066713975', '+2348166213884', '+2349093272572'];
const activeCalls = new Map();

function isAllowed(caller) {
  const normalized = caller.replace(/[^\d]/g, '');
  return ALLOWED_NUMBERS.some(num => normalized.includes(num.replace('+', '')));
}

// Health check
fastify.get('/health', async () => ({ status: 'ok', activeCalls: activeCalls.size }));

// Twilio webhook
fastify.post('/voice/webhook', async (request, reply) => {
  const { From, CallSid } = request.body;
  console.log(`📞 Call from: ${From}`);
  
  if (!isAllowed(From)) {
    return reply.type('text/xml').send(`<?xml version="1.0"?><Response><Say>Not authorized</Say><Hangup/></Response>`);
  }
  
  activeCalls.set(CallSid, { from: From, startTime: Date.now() });
  
  const host = request.headers.host;
  reply.type('text/xml');
  return `<?xml version="1.0"?><Response><Say>Hello, this is Aurelia from CW Real Estate</Say><Connect><Stream url="wss://${host}/voice/stream"/></Connect></Response>`;
});

// WebSocket for streaming
fastify.get('/voice/stream', { websocket: true }, (connection, req) => {
  console.log('🔌 WebSocket connected');
  let streamSid = null;
  let deepgramWs = null;
  
  const connectDeepgram = async () => {
    deepgramWs = new WebSocket('wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2&punctuate=true&interim_results=true', {
      headers: { 'Authorization': `Token ${DEEPGRAM_API_KEY}` }
    });
    
    deepgramWs.on('message', async (data) => {
      const result = JSON.parse(data);
      if (result.is_final && result.channel?.alternatives?.[0]?.transcript) {
        const transcript = result.channel.alternatives[0].transcript.trim();
        if (transcript) {
          console.log(`🗣️ User: ${transcript}`);
          const response = await getAIResponse(transcript);
          console.log(`🤖 Aurelia: ${response}`);
          await sendTTS(connection.socket, streamSid, response);
        }
      }
    });
  };
  
  connection.socket.on('message', async (message) => {
    const data = JSON.parse(message);
    if (data.event === 'start') {
      streamSid = data.start.streamSid;
      await connectDeepgram();
      await sendTTS(connection.socket, streamSid, "I'm listening. What can I help you with today?");
    } else if (data.event === 'media' && deepgramWs?.readyState === WebSocket.OPEN) {
      deepgramWs.send(Buffer.from(data.media.payload, 'base64'));
    }
  });
});

async function getAIResponse(message) {
  try {
    const res = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'moonshot/kimi-k2.5',
        messages: [
          { role: 'system', content: 'You are Aurelia from CW Real Estate. Be professional and concise.' },
          { role: 'user', content: message }
        ],
        max_tokens: 100
      })
    });
    const data = await res.json();
    return data.choices[0].message.content;
  } catch (e) {
    return "I'm sorry, could you repeat that?";
  }
}

async function sendTTS(ws, streamSid, text) {
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5', output_format: 'ulaw_8000' })
    });
    const audio = await res.arrayBuffer();
    ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: Buffer.from(audio).toString('base64') } }));
  } catch (e) {
    console.error('TTS error:', e);
  }
}

const PORT = process.env.PORT || 3334;
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`🚀 Voice bridge running on port ${PORT}`);
});
