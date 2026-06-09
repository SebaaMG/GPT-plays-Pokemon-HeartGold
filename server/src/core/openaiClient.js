const OpenAI = require("openai");
const { config } = require("../config");

let cachedOpenAIClient = null;

function getOpenAIClient() {
  if (!config.openai.apiKey) {
    return null;
  }
  if (!cachedOpenAIClient) {
    cachedOpenAIClient = new OpenAI({
      apiKey: config.openai.apiKey,
      timeout: config.openai.timeout,
    });
  }
  return cachedOpenAIClient;
}

function requireOpenAIClient() {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error(
      "OpenAI API client is not configured. Set OPENAI_API_KEY or use the Codex Desktop/local provider path."
    );
  }
  return client;
}

const openai = new Proxy(
  {},
  {
    get(_target, property) {
      const client = requireOpenAIClient();
      const value = client[property];
      return typeof value === "function" ? value.bind(client) : value;
    },
  }
);

module.exports = { openai, getOpenAIClient, requireOpenAIClient };

