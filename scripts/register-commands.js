const fs = require("node:fs");
const path = require("node:path");

loadEnv();

const DISCORD_API = "https://discord.com/api/v10";

const commands = [
  {
    name: "ping",
    description: "Check whether World Cup AI Bot is online.",
    type: 1,
  },
  {
    name: "today",
    description: "Show today's football matches.",
    type: 1,
  },
  {
    name: "briefing",
    description: "Post an AI-style football briefing now.",
    type: 1,
  },
  {
    name: "help",
    description: "Show bot commands and setup help.",
    type: 1,
  },
];

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function requireEnv(value, name) {
  if (!value || value.startsWith("PASTE_")) {
    throw new Error(`Missing ${name}. Add it to your .env file.`);
  }
}

async function discordRequest(endpoint, options = {}) {
  const response = await fetch(`${DISCORD_API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord request failed: ${response.status} ${body}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function main() {
  requireEnv(token, "DISCORD_TOKEN");
  requireEnv(clientId, "DISCORD_CLIENT_ID");

  if (guildId && !guildId.startsWith("PASTE_")) {
    await discordRequest(`/applications/${clientId}/guilds/${guildId}/commands`, {
      method: "PUT",
      body: JSON.stringify(commands),
    });
    console.log("Registered slash commands for your server.");
    return;
  }

  await discordRequest(`/applications/${clientId}/commands`, {
    method: "PUT",
    body: JSON.stringify(commands),
  });
  console.log("Registered global slash commands. They can take up to 1 hour to appear.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
