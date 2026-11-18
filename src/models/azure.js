import { AzureOpenAI } from "openai";
import { getKey, hasKey } from '../utils/keys.js';
import { GPT } from './gpt.js'

export class AzureGPT extends GPT {
    static prefix = 'azure';
    constructor(model_name, url, params) {
        super(model_name, url)

        this.model_name = model_name;
        this.params = params || {};

        const config = {};

        if (url) {
            config.endpoint = url;
        } else if (hasKey('AZURE_OPENAI_ENDPOINT')) {
            config.endpoint = getKey('AZURE_OPENAI_ENDPOINT');
        } else {
            config.endpoint = 'https://example.openai.azure.com';
        }

        config.apiKey = hasKey('AZURE_OPENAI_API_KEY') ? getKey('AZURE_OPENAI_API_KEY') : (hasKey('OPENAI_API_KEY') ? getKey('OPENAI_API_KEY') : 'none');

        config.deployment = model_name || 'gpt-4o';

        config.apiVersion = this.params.apiVersion || '2024-08-01-preview';
        delete this.params.apiVersion; // remove from params for later use in requests

        this.openai = new AzureOpenAI(config)
    }
}