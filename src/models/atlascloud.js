import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

// deepseek, qwen, kimi, glm
export class AtlasCloud {
	static prefix = 'atlascloud';
	constructor(model_name, url, params) {
    this.model_name = model_name;
    this.url = url || 'https://api.atlascloud.ai/v1';
    this.params = params;


    let config = {
      baseURL: this.url
    };
    config.apiKey = getKey('ATLASCLOUD_API_KEY');

    this.openai = new OpenAIApi(config);
  }

	async sendRequest(turns, systemMessage, stop_seq='***') {
      let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);

      
      messages = strictFormat(messages);
      
      const pack = {
          model: this.model_name || "deepseek-ai/DeepSeek-V3.1-Terminus",
          messages,
          stop: [stop_seq],
          ...(this.params || {})
      };

      let res = null;
      try {
          console.log('Awaiting atlascloud api response...')
          let completion = await this.openai.chat.completions.create(pack);
          if (completion.choices[0].finish_reason == 'length')
              throw new Error('Context length exceeded'); 
          console.log('Received.')
          res = completion.choices[0].message.content;
      }
      catch (err) {
          if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
              console.log('Context length exceeded, trying again with shorter context.');
              return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
          } else {
            console.log(err);
              res = 'My brain disconnected, try again.';
          }
      }
      if (res.includes('<think>')) {
        let start = res.indexOf('<think>');
        let end = res.indexOf('</think>') + 8;
        if (start != -1) {
          if (end != -1) {
            res = res.substring(0, start) + res.substring(end);
          } else {
            res = res.substring(0, start+7);
          }
        }
        res = res.trim();
      }
      return res;
  }

	async embed(text) {
		throw new Error('Embeddings are not supported by Atlas Cloud.');
	}
}
