import { GoogleGenAI } from '@google/genai';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';


export class Gemini {
    static prefix = 'google';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.safetySettings = [
            {
                "category": "HARM_CATEGORY_DANGEROUS",
                "threshold": "BLOCK_NONE",
            },
            {
                "category": "HARM_CATEGORY_HARASSMENT",
                "threshold": "BLOCK_NONE",
            },
            {
                "category": "HARM_CATEGORY_HATE_SPEECH",
                "threshold": "BLOCK_NONE",
            },
            {
                "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "threshold": "BLOCK_NONE",
            },
            {
                "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                "threshold": "BLOCK_NONE",
            },
        ];

        this.genAI = new GoogleGenAI({apiKey: getKey('GEMINI_API_KEY')});
    }

    async sendRequest(turns, systemMessage) {
        console.log('Awaiting Google API response...');

        turns = strictFormat(turns);
        let contents = [];
        for (let turn of turns) {
            contents.push({
                role: turn.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: turn.content }]
            });
        }

        
        const MAX_RETRIES = 5;
        const RETRY_DELAY = 5000;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                const result = await this.genAI.models.generateContent({
                    model: this.model_name || "gemini-2.5-flash",
                    contents: contents,
                    safetySettings: this.safetySettings,
                    config: {
                        systemInstruction: systemMessage,
                        ...(this.params || {})
                    }
                });
                const response = await result.text;
                if (!response) {
                    console.warn(`Gemini returned empty response, retrying in ${RETRY_DELAY/1000}s... (attempt ${attempt + 1}/${MAX_RETRIES})`);
                    await new Promise(r => setTimeout(r, RETRY_DELAY));
                    continue;
                }
                console.log('Received.');
                return response;
            } catch (err) {
                if (attempt < MAX_RETRIES - 1 && (err.status === 503 || err.status === 429)) {
                    console.warn(`Google API error ${err.status}, retrying in ${RETRY_DELAY/1000}s... (attempt ${attempt + 1}/${MAX_RETRIES})`);
                    await new Promise(r => setTimeout(r, RETRY_DELAY));
                } else {
                    throw err;
                }
            }
        }
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const imagePart = {
            inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType: 'image/jpeg'
            }
        };
       
        turns = strictFormat(turns);
        let contents = [];
        for (let turn of turns) {
            contents.push({
                role: turn.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: turn.content }]
            });
        }
        contents.push({
            role: 'user',
            parts: [{ text: 'SYSTEM: Vision response' }, imagePart]
        })

        let res = null;
        try {
            console.log('Awaiting Google API vision response...');
            const result = await this.genAI.models.generateContent({
                model: this.model_name,
                contents: contents,
                safetySettings: this.safetySettings,
                generationConfig: {
                    ...(this.params || {})
                },
                systemInstruction: systemMessage
            });
            res = await result.text;
            console.log('Received.');
        } catch (err) {
            console.log(err);
            if (err.message.includes("Image input modality is not enabled for models/")) {
                res = "Vision is only supported by certain models.";
            } else {
                res = "An unexpected error occurred, please try again.";
            }
        }
        return res;
    }

    async embed(text) {
        const result = await this.genAI.models.embedContent({
            model: this.model_name || "gemini-embedding-001",
            contents: text,
        })

        return result.embeddings;
    }
}

const sendAudioRequest = async (text, model, voice, url) => {
    const ai = new GoogleGenAI({apiKey: getKey('GEMINI_API_KEY')});

    const response = await ai.models.generateContent({
        model: model,
        contents: [{ parts: [{text: text}] }],
        config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voice },
                },
            },
        },
    })

    const pcmBase64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!pcmBase64) {
        console.warn('Gemini TTS: no audio data returned');
        return null;
    }

    // Wrap PCM in a minimal WAV container so ffplay can decode it.
    const pcmBuffer = Buffer.from(pcmBase64, 'base64');
    const wavHeader = createWavHeader(pcmBuffer.length, 24000, 1, 16);
    const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);

    const wavBase64 = wavBuffer.toString('base64');
    return wavBase64;
}

// helper: create PCM WAV header
function createWavHeader(dataLength, sampleRate, channels, bitsPerSample) {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * channels * bitsPerSample / 8;
    const blockAlign = channels * bitsPerSample / 8;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // PCM
    header.writeUInt16LE(1, 20); // Audio format = PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);
    return header;
}

export const TTSConfig = {
    sendAudioRequest: sendAudioRequest,
}
