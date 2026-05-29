const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

loadEnv();

const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

const config = {
  token: process.env.DISCORD_TOKEN,
  channelId: process.env.DISCORD_CHANNEL_ID,
  intervalMinutes: Number(process.env.UPDATE_INTERVAL_MINUTES || 60),
  port: Number(process.env.PORT || 10000),
  timezone: process.env.TIMEZONE || "Asia/Kuala_Lumpur",
  autoReply: process.env.DISCORD_AUTO_REPLY || "mention",
  provider: process.env.FOOTBALL_PROVIDER || "demo",
  apiFootballKey: process.env.API_FOOTBALL_KEY,
  apiFootballLeagueId: process.env.API_FOOTBALL_LEAGUE_ID || "1",
  apiFootballSeason: process.env.API_FOOTBALL_SEASON || "2026",
  openAiKey: process.env.OPENAI_API_KEY,
};

let socket;
let sequence = null;
let heartbeatTimer = null;
let sessionId = null;
let lastAutoPostSignature = "";
let botUserId = null;
let healthServer = null;

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

function startHealthServer() {
  healthServer = http.createServer((request, response) => {
    const isHealthCheck = request.url === "/" || request.url === "/health";
    if (!isHealthCheck) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "Not found" }));
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        service: "World Cup AI Bot",
        discord: socket?.readyState === WebSocket.OPEN ? "connected" : "connecting",
      }),
    );
  });

  healthServer.listen(config.port, "0.0.0.0", () => {
    console.log(`Health server listening on port ${config.port}.`);
  });
}

function formatDate(date, timezone = config.timezone) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(date);
}

function getDemoMatches() {
  const now = new Date();
  return [
    {
      home: "Mexico",
      away: "Canada",
      status: "Preview",
      kickoff: new Date("2026-06-11T15:00:00-06:00"),
      score: "-",
      venue: "Mexico City",
    },
    {
      home: "United States",
      away: "TBD",
      status: "Upcoming",
      kickoff: new Date(now.getTime() + 1000 * 60 * 60 * 8),
      score: "-",
      venue: "North America",
    },
    {
      home: "Brazil",
      away: "England",
      status: "Demo friendly",
      kickoff: new Date(now.getTime() + 1000 * 60 * 60 * 30),
      score: "0-0",
      venue: "AI demo board",
    },
  ];
}

async function fetchApiFootballMatches() {
  requireEnv(config.apiFootballKey, "API_FOOTBALL_KEY");

  const params = new URLSearchParams({
    league: config.apiFootballLeagueId,
    season: config.apiFootballSeason,
  });

  const response = await fetch(`https://v3.football.api-sports.io/fixtures?${params}`, {
    headers: {
      "x-apisports-key": config.apiFootballKey,
    },
  });

  if (!response.ok) {
    throw new Error(`API-Football request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const apiErrors = Array.isArray(data.errors)
    ? data.errors
    : Object.values(data.errors || {}).filter(Boolean);
  if (apiErrors.length) {
    throw new Error(`API-Football error: ${apiErrors.join(" | ")}`);
  }

  const fixtures = Array.isArray(data.response) ? data.response : [];
  console.log(`API-Football returned ${fixtures.length} World Cup fixtures.`);

  const matches = fixtures.map((item) => {
    const homeGoals = item.goals?.home;
    const awayGoals = item.goals?.away;
    return {
      home: item.teams?.home?.name || "Home",
      away: item.teams?.away?.name || "Away",
      status: item.fixture?.status?.short || item.fixture?.status?.long || "Scheduled",
      kickoff: item.fixture?.date ? new Date(item.fixture.date) : new Date(),
      score: homeGoals === null || awayGoals === null ? "-" : `${homeGoals}-${awayGoals}`,
      venue: item.fixture?.venue?.name || "Venue TBA",
    };
  });

  const now = Date.now();
  const liveStatuses = new Set(["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"]);
  const statusPriority = (match) => {
    if (liveStatuses.has(match.status)) return 0;
    if (match.kickoff.getTime() >= now) return 1;
    return 2;
  };

  return matches
    .sort((a, b) => {
      const priorityDifference = statusPriority(a) - statusPriority(b);
      if (priorityDifference !== 0) return priorityDifference;

      if (statusPriority(a) === 2) {
        return b.kickoff.getTime() - a.kickoff.getTime();
      }

      return a.kickoff.getTime() - b.kickoff.getTime();
    })
    .slice(0, 10);
}

async function fetchMatches() {
  if (config.provider === "api-football") {
    return fetchApiFootballMatches();
  }

  return getDemoMatches();
}

function buildMatchLines(matches) {
  if (!matches.length) {
    return ["No matches found right now. The bot will check again later."];
  }

  return matches.slice(0, 8).map((match) => {
    const kickoff = formatDate(match.kickoff);
    return `**${match.home} vs ${match.away}** | ${match.score} | ${match.status}\n${kickoff} | ${match.venue}`;
  });
}

function buildTemplateBriefing(matches) {
  const liveMatches = matches.filter((match) => /1H|2H|HT|ET|P|LIVE/i.test(match.status));
  const nextMatch = matches[0];
  const lead = liveMatches.length
    ? `${liveMatches.length} live match${liveMatches.length > 1 ? "es are" : " is"} being tracked now.`
    : nextMatch
      ? `Next spotlight: ${nextMatch.home} vs ${nextMatch.away}.`
      : "No active fixtures found right now.";

  const bullets = [
    lead,
    "Fans can use #match-chat for reactions and predictions.",
    "This briefing is ready to connect to a real football API when you add an API key.",
  ];

  return bullets.map((line) => `- ${line}`).join("\n");
}

async function buildOpenAiBriefing(matches) {
  if (!config.openAiKey) {
    return buildTemplateBriefing(matches);
  }

  const compactMatches = matches.slice(0, 8).map((match) => ({
    home: match.home,
    away: match.away,
    status: match.status,
    score: match.score,
    kickoff: match.kickoff.toISOString(),
    venue: match.venue,
  }));

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openAiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "You write short English football briefings for a global Discord community. Be accurate, exciting, and concise.",
        },
        {
          role: "user",
          content: `Create a Discord briefing from these fixtures. Use 3 bullet points maximum:\n${JSON.stringify(compactMatches)}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    return buildTemplateBriefing(matches);
  }

  const data = await response.json();
  return data.output_text || buildTemplateBriefing(matches);
}

async function buildOpenAiAnswer(question, matches) {
  if (!config.openAiKey) {
    return null;
  }

  const compactMatches = matches.slice(0, 6).map((match) => ({
    home: match.home,
    away: match.away,
    status: match.status,
    score: match.score,
    kickoff: match.kickoff.toISOString(),
    venue: match.venue,
  }));

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openAiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "You are World Cup AI Bot in a Discord football community. Sound warm, human, and match-room smart. Reply in short friendly English unless the user writes Chinese, then reply in simple Chinese. Be honest when data is demo data. Do not pretend to know live results unless fixture data says so.",
        },
        {
          role: "user",
          content: `User question: ${question}\nCurrent fixtures: ${JSON.stringify(compactMatches)}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  return data.output_text || null;
}

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function hasChinese(text) {
  return /[\u3400-\u9fff]/.test(text);
}

function pick(options) {
  return options[Math.floor(Math.random() * options.length)];
}

function getDisplayName(message) {
  return message?.member?.nick || message?.author?.global_name || message?.author?.username || "friend";
}

function buildHumanTemplateAnswer(question, matches, displayName) {
  const normalized = question.toLowerCase();
  const isChinese = hasChinese(question);
  const nextMatch = matches[0];
  const nextLine = nextMatch
    ? `${nextMatch.home} vs ${nextMatch.away} is my next spotlight. Kickoff: ${formatDate(nextMatch.kickoff)}.`
    : "I do not see a match on the board right now.";

  if (includesAny(normalized, ["hello", "hi", "hey", "good morning", "good evening", "\u4f60\u597d", "\u55e8"])) {
    if (isChinese) {
      return `\u4f60\u597d ${displayName}\uff0c\u6211\u5728\u3002\u6211\u53ef\u4ee5\u5e2e\u4f60\u770b\u6bd4\u8d5b\u3001\u6bd4\u5206\u3001\u4e16\u754c\u676f\u65b0\u95fb\uff0c\u4e5f\u53ef\u4ee5\u7528 /briefing \u751f\u6210\u82f1\u6587\u7b80\u62a5\u3002`;
    }

    return pick([
      `Hey ${displayName}, I am here. Ask me about matches, scores, World Cup news, or use /briefing for a clean match-room update.`,
      `Hi ${displayName}. I am watching the football board. Try asking: "today match", "any news", or "give me a briefing".`,
      `Hello ${displayName}. I am ready for match talk, predictions, and short football briefings.`,
    ]);
  }

  if (includesAny(normalized, ["thanks", "thank you", "thx", "\u8c22\u8c22", "\u8b1d\u8b1d"])) {
    return isChinese
      ? `\u4e0d\u5ba2\u6c14 ${displayName}\u3002\u6709\u6bd4\u8d5b\u6216\u65b0\u95fb\u60f3\u770b\uff0c\u76f4\u63a5 @ \u6211\u5c31\u884c\u3002`
      : `Anytime, ${displayName}. I will keep the football updates warm for the group.`;
  }

  if (
    includesAny(normalized, [
      "who are you",
      "what can you do",
      "help",
      "\u4f60\u662f\u8c01",
      "\u4f60\u4f1a\u4ec0\u4e48",
      "\u5e2e\u52a9",
    ])
  ) {
    return isChinese
      ? `\u6211\u662f World Cup AI Bot\uff0cWorld Cup AI Club \u7684\u8db3\u7403\u52a9\u624b\u3002\u6211\u73b0\u5728\u53ef\u4ee5\u56de\u590d @ \u6211\u7684\u95ee\u9898\uff0c\u4e5f\u652f\u6301 /ping\u3001/today\u3001/briefing\u3002`
      : `I am World Cup AI Bot, the football assistant for World Cup AI Club. I can answer mentions, show match lists, and prepare short briefings. Try /today or /briefing.`;
  }

  if (
    includesAny(normalized, [
      "briefing",
      "news",
      "update",
      "\u65b0\u95fb",
      "\u7b80\u62a5",
      "\u6700\u65b0",
    ])
  ) {
    return `World Cup AI Briefing\n\n${buildTemplateBriefing(matches)}\n\nMy read: ${nextLine}\n\nUse /briefing for the full card.`;
  }

  if (
    includesAny(normalized, [
      "match",
      "score",
      "today",
      "fixture",
      "schedule",
      "\u6bd4\u8d5b",
      "\u6bd4\u5206",
      "\u8d5b\u7a0b",
      "\u4eca\u5929",
    ])
  ) {
    return `Here is what I am tracking right now:\n\n${buildMatchLines(matches).join("\n\n")}\n\n${nextLine}\n\nUse /today any time for the clean list.`;
  }

  if (includesAny(normalized, ["predict", "prediction", "who will win", "\u9884\u6d4b", "\u8c01\u4f1a\u8d62"])) {
    return `My early read is cautious: ${nextLine}\n\nI do not want to fake certainty, but I can compare form, lineups, and match rhythm once live data is connected.`;
  }

  if (isChinese) {
    return `\u6211\u6536\u5230\u4e86\uff0c${displayName}\u3002\u6211\u73b0\u5728\u80fd\u505a\u57fa\u7840\u8db3\u7403\u56de\u590d\uff1a\u4f60\u53ef\u4ee5\u95ee\u6211\u6bd4\u8d5b\u3001\u6bd4\u5206\u3001\u4e16\u754c\u676f\u65b0\u95fb\uff0c\u6216\u8f93\u5165 /briefing\u3002\u5982\u679c\u4ee5\u540e\u63a5\u5165 OpenAI API\uff0c\u6211\u5c31\u80fd\u50cf\u771f\u6b63\u7684\u804a\u5929 AI \u4e00\u6837\u56de\u7b54\u66f4\u590d\u6742\u7684\u95ee\u9898\u3002`;
  }

  return pick([
    `I hear you, ${displayName}. I am best with football questions right now: matches, scores, news, predictions, and briefings. Try asking me for today's match list.`,
    `Good question, ${displayName}. My free mode is focused on football updates. Ask about fixtures, scores, or World Cup news and I will keep it sharp.`,
    `I am still in match-room mode, ${displayName}. Give me a team, match, or news question and I will help.`,
  ]);
}

async function buildChatAnswer(question, message = null) {
  const matches = await fetchMatches();
  const aiAnswer = await buildOpenAiAnswer(question, matches);
  if (aiAnswer) {
    return aiAnswer.slice(0, 1900);
  }

  return buildHumanTemplateAnswer(question, matches, getDisplayName(message));
}

async function createBriefingEmbed() {
  const matches = await fetchMatches();
  const briefing = await buildOpenAiBriefing(matches);

  return {
    color: 0xf0c45c,
    title: "World Cup AI Briefing",
    description: briefing,
    fields: [
      {
        name: "Upcoming / Live Matches",
        value: buildMatchLines(matches).join("\n\n").slice(0, 1024),
      },
    ],
    footer: {
      text: `World Cup AI Club | ${config.provider === "demo" ? "Demo data" : "Live football data"}`,
    },
    timestamp: new Date().toISOString(),
  };
}

async function discordRequest(endpoint, options = {}) {
  const response = await fetch(`${DISCORD_API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bot ${config.token}`,
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

async function postChannelMessage(channelId, payload) {
  return discordRequest(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function sendTyping(channelId) {
  await discordRequest(`/channels/${channelId}/typing`, {
    method: "POST",
  });
}

async function replyToMessage(message, content) {
  await sendTyping(message.channel_id).catch(() => {});
  await postChannelMessage(message.channel_id, {
    content: content.slice(0, 1900),
    message_reference: {
      message_id: message.id,
      channel_id: message.channel_id,
      guild_id: message.guild_id,
      fail_if_not_exists: false,
    },
    allowed_mentions: {
      parse: [],
    },
  });
}

async function replyToInteraction(interaction, payload, ephemeral = false) {
  const data = typeof payload === "string" ? { content: payload } : payload;
  if (ephemeral) {
    data.flags = 64;
  }

  await fetch(`${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: 4,
      data,
    }),
  });
}

async function postAutomaticBriefing() {
  if (!config.channelId || config.channelId.startsWith("PASTE_")) {
    console.log("DISCORD_CHANNEL_ID is empty. Automatic posting is disabled.");
    return;
  }

  const embed = await createBriefingEmbed();
  const signature = JSON.stringify(embed.fields || []);
  if (signature === lastAutoPostSignature) {
    console.log("No new briefing content. Skipping duplicate post.");
    return;
  }

  lastAutoPostSignature = signature;
  await postChannelMessage(config.channelId, { embeds: [embed] });
  console.log("Posted automatic football briefing.");
}

async function handleInteraction(interaction) {
  const commandName = interaction.data?.name;
  if (!commandName) return;

  if (commandName === "ping") {
    await replyToInteraction(interaction, "World Cup AI Bot is online.");
    return;
  }

  if (commandName === "help") {
    await replyToInteraction(
      interaction,
      "Commands:\n/ping - check bot status\n/today - show matches\n/briefing - post an AI-style briefing now\n\nSet DISCORD_CHANNEL_ID to enable automatic updates.",
      true,
    );
    return;
  }

  if (commandName === "today") {
    const matches = await fetchMatches();
    await replyToInteraction(interaction, buildMatchLines(matches).join("\n\n"));
    return;
  }

  if (commandName === "briefing") {
    const embed = await createBriefingEmbed();
    await replyToInteraction(interaction, { embeds: [embed] });
  }
}

async function handleMessage(message) {
  if (message.author?.bot) return;
  if (!message.content) return;

  const mentioned = Array.isArray(message.mentions)
    ? message.mentions.some((user) => user.id === botUserId)
    : false;
  const shouldReply = config.autoReply === "all" || mentioned;
  if (!shouldReply) return;

  const question = message.content
    .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
    .trim();
  const answer = await buildChatAnswer(question || "help", message);
  await replyToMessage(message, answer);
}

function send(payload) {
  socket.send(JSON.stringify(payload));
}

function startHeartbeat(interval) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    send({ op: 1, d: sequence });
  }, interval);
}

function identify() {
  send({
    op: 2,
    d: {
      token: config.token,
      intents: 1 | 512,
      properties: {
        os: "windows",
        browser: "worldcup-ai-bot",
        device: "worldcup-ai-bot",
      },
    },
  });
}

function connectGateway() {
  socket = new WebSocket(GATEWAY_URL);

  socket.addEventListener("open", () => {
    console.log("Connected to Discord Gateway.");
  });

  socket.addEventListener("message", async (event) => {
    const packet = JSON.parse(event.data);
    if (packet.s !== null && packet.s !== undefined) sequence = packet.s;

    if (packet.op === 10) {
      startHeartbeat(packet.d.heartbeat_interval);
      identify();
      return;
    }

    if (packet.op === 11) return;

    if (packet.t === "READY") {
      sessionId = packet.d.session_id;
      botUserId = packet.d.user.id;
      console.log(`World Cup AI Bot logged in as ${packet.d.user.username}.`);
      postAutomaticBriefing().catch((error) => {
        console.error("Initial automatic briefing failed:", error.message);
      });
      return;
    }

    if (packet.t === "INTERACTION_CREATE") {
      handleInteraction(packet.d).catch((error) => {
        console.error("Interaction failed:", error.message);
        replyToInteraction(packet.d, "Sorry, the bot hit an error. Check the console logs.", true).catch(() => {});
      });
    }

    if (packet.t === "MESSAGE_CREATE") {
      handleMessage(packet.d).catch((error) => {
        console.error("Message reply failed:", error.message);
      });
    }
  });

  socket.addEventListener("close", (event) => {
    console.log(`Gateway closed (${event.code}). Reconnecting in 5 seconds.`);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    setTimeout(connectGateway, 5000);
  });

  socket.addEventListener("error", (event) => {
    console.error("Gateway error:", event.message || "unknown error");
  });
}

requireEnv(config.token, "DISCORD_TOKEN");
startHealthServer();

setInterval(() => {
  postAutomaticBriefing().catch((error) => {
    console.error("Automatic briefing failed:", error.message);
  });
}, Math.max(config.intervalMinutes, 5) * 60 * 1000);

connectGateway();

module.exports = {
  buildTemplateBriefing,
  buildMatchLines,
  buildChatAnswer,
  getDemoMatches,
};
