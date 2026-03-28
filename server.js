const express = require("express");
const https = require("https");
const app = express();

app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const GH_TOKEN = process.env.GH_TOKEN;
const SECRET = process.env.CRON_SECRET;

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const data = "chat_id=" + CHAT_ID + "&text=" + encodeURIComponent(text) + "&parse_mode=HTML";
    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + BOT_TOKEN + "/sendMessage",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function ghAPI(path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: path,
      method: method,
      headers: {
        "Authorization": "Bearer " + GH_TOKEN,
        "User-Agent": "openclaw-notifier",
        "Accept": "application/vnd.github+json"
      }
    };
    if (body) options.headers["Content-Length"] = Buffer.byteLength(JSON.stringify(body));

    const req = https.request(options, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

app.get("/", (req, res) => res.send("OK"));

// Telegram webhook - handles user replies
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body && req.body.message;
    if (!message || !message.text) return res.send("OK");

    const chatId = String(message.chat.id);
    if (chatId !== CHAT_ID) return res.send("OK");

    const text = message.text.trim();

    // Handle /start
    if (text === "/start") {
      await sendTelegram("🍳 FoodXp Notifier Bot\n\nCommands:\n• Send #286 to see details\n• /code 286 — start AI coding on issue\n• /issues — show all assigned issues\n• /prs — show open PRs\n• /help — show this message");
      return res.send("OK");
    }

    // Handle /help
    if (text === "/help") {
      await sendTelegram("🍳 FoodXp Notifier Bot\n\nCommands:\n• Send an issue number like #286 to see details\n• /issues — show all assigned issues\n• /prs — show open PRs\n• /help — show this message");
      return res.send("OK");
    }

    // Handle /issues
    if (text === "/issues") {
      const issues = await ghAPI("/repos/travelxp/foodxp-cms/issues?assignee=AnishTxp&state=open");
      const filtered = issues.filter(i => !i.pull_request);
      if (filtered.length === 0) {
        await sendTelegram("No open issues assigned to you.");
        return res.send("OK");
      }
      const list = filtered.map(i => {
        const labels = i.labels.map(l => l.name).join(", ");
        return "• #" + i.number + " — " + i.title + " [" + labels + "]";
      }).join("\n");
      await sendTelegram("📋 " + filtered.length + " open issues:\n\n" + list + "\n\nSend #number for details.");
      return res.send("OK");
    }

    // Handle /prs
    if (text === "/prs") {
      const prs = await ghAPI("/repos/travelxp/foodxp-cms/pulls?state=open");
      const myPRs = prs.filter(p => p.user.login === "AnishTxp");
      if (myPRs.length === 0) {
        await sendTelegram("No open PRs.");
        return res.send("OK");
      }
      const list = myPRs.map(p => "• PR #" + p.number + " — " + p.title + "\n  " + p.html_url).join("\n");
      await sendTelegram("🔀 " + myPRs.length + " open PRs:\n\n" + list);
      return res.send("OK");
    }

    // Handle issue number (#123 or just 123)
    const issueMatch = text.match(/#?(\d+)/);
    if (issueMatch) {
      const issueNum = issueMatch[1];
      const issue = await ghAPI("/repos/travelxp/foodxp-cms/issues/" + issueNum);

      if (issue.message === "Not Found") {
        await sendTelegram("Issue #" + issueNum + " not found.");
        return res.send("OK");
      }

      const labels = issue.labels ? issue.labels.map(l => l.name).join(", ") : "none";
      const assignees = issue.assignees ? issue.assignees.map(a => a.login).join(", ") : "none";
      const body = issue.body ? issue.body.substring(0, 1000) : "No description";
      const isPR = issue.pull_request ? "🔀 Pull Request" : "📋 Issue";

      const msg = isPR + " #" + issueNum + "\n\n"
        + "<b>" + issue.title + "</b>\n\n"
        + "State: " + issue.state + "\n"
        + "Labels: " + labels + "\n"
        + "Assignees: " + assignees + "\n"
        + "Created: " + new Date(issue.created_at).toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" }) + "\n\n"
        + body + "\n\n"
        + "🔗 " + issue.html_url;

      await sendTelegram(msg);
      return res.send("OK");
    }

    // Handle /code (starts OpenClaw agent)
    if (text.startsWith("/code")) {
      const issueNum = text.split(" ")[1];
      if (!issueNum) {
        await sendTelegram("Please provide an issue number, e.g., /code 286");
        return res.send("OK");
      }

      await sendTelegram("🤖 Triggering <b>OpenClaw</b> for Issue #" + issueNum + "...\nModel: OpenRouter (Claude-3.5-Sonnet)");
      
      const payload = {
        ref: "main", // or your default branch
        inputs: { issue_number: issueNum.replace("#", "") }
      };

      await ghAPI("/repos/travelxp/foodxp-cms/actions/workflows/openclaw.yml/dispatches", "POST", payload);
      await sendTelegram("✅ Workflow dispatched! Tracking progress on GitHub...");
      return res.send("OK");
    }

    await sendTelegram("I didn't understand that. Send #number for issue details, /code number to start AI coding, or /help for commands.");
    return res.send("OK");
  } catch (e) {
    console.error(e);
    return res.send("OK");
  }
});

app.get("/digest", async (req, res) => {
  if (req.query.secret !== SECRET) return res.status(403).send("Forbidden");
  try {
    const issues = await ghAPI("/repos/travelxp/foodxp-cms/issues?assignee=AnishTxp&state=open");
    const filtered = issues.filter(i => !i.pull_request);
    if (filtered.length === 0) return res.send("No issues");
    const list = filtered.map(i => {
      const labels = i.labels.map(l => l.name).join(", ");
      return "• #" + i.number + " — " + i.title + " [" + labels + "]";
    }).join("\n");
    const date = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Kolkata" });
    const message = "🍳 Morning Issue Digest\n📅 " + date + "\n📋 " + filtered.length + " open issues assigned to you:\n\n" + list + "\n\nSend #number for details.";
    await sendTelegram(message);
    res.send("Digest sent");
  } catch (e) { console.error(e); res.status(500).send(e.message); }
});

app.get("/pr-comments", async (req, res) => {
  if (req.query.secret !== SECRET) return res.status(403).send("Forbidden");
  try {
    const prs = await ghAPI("/repos/travelxp/foodxp-cms/pulls?state=open");
    const myPRs = prs.filter(p => p.user.login === "AnishTxp");
    if (myPRs.length === 0) return res.send("No open PRs");
    /* In server.js */
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    for (const pr of myPRs) {
      const comments = await ghAPI("/repos/travelxp/foodxp-cms/pulls/" + pr.number + "/comments");
      const reviews = await ghAPI("/repos/travelxp/foodxp-cms/pulls/" + pr.number + "/reviews");
      const newComments = comments.filter(c => c.created_at > since && c.user.login !== "AnishTxp").map(c => "💬 " + c.user.login + " on PR #" + pr.number + ":\n" + c.body);
      const newReviews = reviews.filter(r => r.submitted_at > since && r.user.login !== "AnishTxp" && r.body).map(r => "📝 " + r.user.login + " reviewed PR #" + pr.number + " (" + r.state + "):\n" + r.body);
      const all = [...newComments, ...newReviews];
      if (all.length > 0) {
        const message = "🔔 New PR Comments\n\n" + all.join("\n\n") + "\n\nOpen Claude Code to draft replies.";
        await sendTelegram(message);
      }
    }
    res.send("Check complete");
  } catch (e) { console.error(e); res.status(500).send(e.message); }
});

// Register webhook on startup
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("Server running on port " + PORT);
  // Set Telegram webhook
  const webhookUrl = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL;
  if (webhookUrl) {
    const url = "https://api.telegram.org/bot" + BOT_TOKEN + "/setWebhook?url=" + encodeURIComponent(webhookUrl + "/webhook");
    https.get(url, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => console.log("Webhook set:", d));
    });
  }
});
