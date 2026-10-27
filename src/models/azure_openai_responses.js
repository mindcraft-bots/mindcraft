import { AzureOpenAI } from 'openai';
import { getKey } from '../utils/keys.js';
import { OpenAICompletions } from './openai_compatible.js';

// Azure OpenAI protocol implementation.
export class AzureOpenAIResponses extends OpenAICompletions {
    static prefix = 'azure-openai-responses';

    initClient() {
        this.params = this.params || {};
        this.provider = 'azure';
        this.deployment = this.params.deployment || this.params.deploymentName || this.params.deployment_name || this.model_name;
        delete this.params.deployment;
        delete this.params.deploymentName;
        delete this.params.deployment_name;
        this.default_model = this.model_name || this.deployment;

        const config = {};
        if (this.url) config.endpoint = this.url;

        const apiKeyName = this.params.apiKeyName || this.params.api_key_name || 'AZURE_OPENAI_API_KEY';
        delete this.params.apiKeyName;
        delete this.params.api_key_name;
        config.apiKey = getKey(apiKeyName);
        config.deployment = this.deployment;

        if (this.params.apiVersion) {
            config.apiVersion = this.params.apiVersion;
            delete this.params.apiVersion;
        } else {
            throw new Error('apiVersion is required in params for azure-openai-responses!');
        }

        this.openai = new AzureOpenAI(config);
    }
}
