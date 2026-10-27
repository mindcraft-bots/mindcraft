import { exec, spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { TTSConfig as gptTTSConfig } from '../models/openai_compatible.js';
import { TTSConfig as geminiTTSConfig } from '../models/google_generative_ai.js';

let speakingQueue = []; // each item: {text, model, audioData, ready}
let isSpeaking = false;

export function speak(text, speak_model) {
    const model = speak_model || 'system';

    const item = { text, model, audioData: null, ready: null };

    if (model === 'system') {
        // no preprocessing needed
        item.ready = Promise.resolve();
    } else {
        item.ready = fetchRemoteAudio(text, model)
            .then(data => { item.audioData = data; })
            .catch(err => { item.error = err; });
    }

    speakingQueue.push(item);
    if (!isSpeaking) void processQueue();
}

async function fetchRemoteAudio(txt, model) {
    function getModelUrl(prov) {
        if (prov === 'openai') return gptTTSConfig.baseUrl;
        if (prov === 'google') return geminiTTSConfig.baseUrl;
        return 'https://api.openai.com/v1';
    }

    let prov, mdl, voice, url;
    if (typeof model === 'string') {
        [prov, mdl, voice] = model.split('/');
        url = getModelUrl(prov);
    } else {
        prov = model.api;
        mdl = model.model;
        voice = model.voice;
        url = model.url || getModelUrl(prov);
    }

    if (prov === 'openai') {
        return gptTTSConfig.sendAudioRequest(txt, mdl, voice, url);
    } else if (prov === 'google') {
        return geminiTTSConfig.sendAudioRequest(txt, mdl, voice, url);
    }
    else {
        throw new Error(`TTS Provider ${prov} is not supported.`);
    }
}

async function processQueue() {
    isSpeaking = true;
    if (speakingQueue.length === 0) {
        isSpeaking = false;
        return;
    }
    const item = speakingQueue.shift();
    const { text: txt, model, audioData } = item;
    if (txt.trim() === '') {
        isSpeaking = false;
        void processQueue();
        return;
    }
    console.log(`[TTS] speaking ${txt.length} chars: ${txt}`);

    // wait for preprocessing if needed
    try {
        await item.ready;
        if (item.error) throw item.error;
    } catch (err) {
        console.error('[TTS] preprocess error', err);
        isSpeaking = false;
        void processQueue();
        return;
    }

    if (model === 'system') {
        // Use argv-based system TTS on macOS/Linux so punctuation such as
        // "hello world, codex" or "hello world! I am codex" cannot be
        // truncated or reinterpreted by a shell command line.
        const invocation = buildSystemTTSInvocation(txt, process.platform);
        if (invocation.mode === 'exec') {
            exec(invocation.command, err => {
                if (err) console.error('TTS error', err);
                isSpeaking = false;
                void processQueue();
            });
        } else {
            const player = spawn(invocation.command, invocation.args, { stdio: 'ignore' });
            player.on('error', err => {
                console.error('TTS error', err);
                isSpeaking = false;
                void processQueue();
            });
            player.on('exit', () => {
                isSpeaking = false;
                void processQueue();
            });
        }

    } 
    else {
        // audioData was already fetched in speak()
        const audioData = item.audioData;

        if (!audioData) {
            console.error('[TTS] No audio data ready');
            isSpeaking = false;
            void processQueue();
            return;
        }

        try {
            if (isWin) {
                const tmpPath = path.join(os.tmpdir(), `tts_${Date.now()}.mp3`);
                await fs.writeFile(tmpPath, Buffer.from(audioData, 'base64'));

                const player = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', tmpPath], {
                    stdio: 'ignore', windowsHide: true
                });
                player.on('error', async (err) => {
                    console.error('[TTS] ffplay error', err);
                    try { await fs.unlink(tmpPath); } catch (unlinkError) { console.warn('[TTS] cleanup error', unlinkError); }
                    isSpeaking = false;
                    void processQueue();
                });
                player.on('exit', async () => {
                    try { await fs.unlink(tmpPath); } catch (unlinkError) { console.warn('[TTS] cleanup error', unlinkError); }
                    isSpeaking = false;
                    void processQueue();
                });

            } else {
                const player = spawn('ffplay', ['-nodisp','-autoexit','pipe:0'], {
                    stdio: ['pipe','ignore','ignore']
                });
                player.stdin.write(Buffer.from(audioData, 'base64'));
                player.stdin.end();
                player.on('exit', () => {
                    isSpeaking = false;
                    void processQueue();
                });
            }
        } catch (e) {
            console.error('[TTS] Audio error', e);
            isSpeaking = false;
            void processQueue();
        }
    }
}

export function buildSystemTTSInvocation(text, platform = process.platform) {
    const txt = String(text ?? '');
    if (platform === 'win32') {
        return {
            mode: 'exec',
            command: `powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; \
            $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate=2; \
            $s.Speak('${txt.replace(/'/g,"''")}'); $s.Dispose()"`
        };
    }
    if (platform === 'darwin') {
        const voice = process.env.MINDCRAFT_SYSTEM_TTS_VOICE;
        return {
            mode: 'spawn',
            command: 'say',
            args: voice ? ['-v', voice, txt] : [txt]
        };
    }
    return {
        mode: 'spawn',
        command: 'espeak',
        args: [txt]
    };
}
