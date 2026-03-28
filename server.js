const express = require("express");
const https = require("https");
const app = express();

app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const GH_TOKEN = process.env.GH_TOKEN;
const SECRET = process.env.CRON_SECRET;
const BC_TOKEN = process.env.BC_ACCESS_TOKEN;
const BC_ACCOUNT = process.env.BC_ACCOUNT_ID;
const BC_EMAIL = process.env.BC_USER_EMAIL;

function sendTelegram(text, extra = {}) {
  return new Promise((resolve, reject) => {
    const payload = { chat_id: CHAT_ID, text: text, parse_mode: "HTML", ...extra };
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + BOT_TOKEN + "/sendMessage",
      method: "POST",
      headers: { "Content-Type": "application/json" }
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

function bcAPI(path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "3.basecampapi.com",
      path: "/" + BC_ACCOUNT + path,
      method: method,
      headers: {
        "Authorization": "Bearer " + BC_TOKEN,
        "User-Agent": "FoodXp Bot (" + BC_EMAIL + ")",
        "Accept": "application/json"
      }
    };
    if (body) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(JSON.stringify(body));
    }
    const req = https.request(options, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(d ? JSON.parse(d) : []); } catch (e) { resolve([]); }
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
    const callback = req.body && req.body.callback_query;

    // Handle Callback Queries (Buttons)
    if (callback) {
      const data = callback.data;
      const chatId = String(callback.message.chat.id);
      if (chatId !== CHAT_ID) return res.send("OK");

      // Step 2: Project selected -> Show PRs
      if (data.startsWith("rv_p:")) {
        const projectId = data.split(":")[1];
        const prs = await ghAPI("/repos/travelxp/foodxp-cms/pulls?state=open");
        const myPRs = prs.filter(p => p.user.login === "AnishTxp");
        
        if (myPRs.length === 0) {
          await sendTelegram("No open PRs found to review.");
          return res.send("OK");
        }

        const buttons = myPRs.map(p => ([{ text: "PR #" + p.number + ": " + p.title.substring(0, 30), callback_data: "rv_s:" + projectId + ":" + p.number }]));
        await sendTelegram("Selected Project: " + projectId + "\n\nSelect a PR to share:", {
          reply_markup: { inline_keyboard: buttons }
        });
      }

      // Step 3: PR selected -> Post to Basecamp
      if (data.startsWith("rv_s:")) {
        const [_, pId, prNum] = data.split(":");
        const pr = await ghAPI("/repos/travelxp/foodxp-cms/pulls/" + prNum);
        
        // Find Campfire ID
        const project = await bcAPI("/buckets/" + pId + ".json");
        const campfireTool = project.dock.find(t => t.name === "chat" || t.title === "Campfire");
        
        if (!campfireTool) {
          await sendTelegram("❌ Could not find a Campfire chat for this project.");
          return res.send("OK");
        }

        const chatIdBC = campfireTool.url.split("/").pop().replace(".json", "");
        const msgText = pr.html_url + " 🌳 Dhruv sir please review this PR";
        
        await bcAPI("/buckets/" + pId + "/chats/" + chatIdBC + "/lines.json", "POST", { content: msgText });
        await sendTelegram("✅ Posted to Basecamp Campfire!");
      }
      return res.send("OK");
    }

    if (!message || !message.text) return res.send("OK");
    const chatId = String(message.chat.id);
    if (chatId !== CHAT_ID) return res.send("OK");
    const text = message.text.trim();

    const helpMsg = "🍳 <b>FoodXp Notifier Bot Help</b>\n\n"
      + "<b>Commands:</b>\n"
      + "• Send #286 — view full issue task / description\n"
      + "• /code 286 — start AI coding on ANY issue\n\n"
      + "<b>Lists:</b>\n"
      + "• /issues foodxp-cms — all issues in CMS\n"
      + "• /issues foodxp-b2c-service — all issues in B2C\n"
      + "• /issues foodxp-mongodb — all issues in MongoDB\n"
      + "• /issues_assigned — issues assigned to you\n"
      + "• /prs — show your open PRs\n\n"
      + "<b>Basecamp:</b>\n"
      + "• /bc_todos — show your assigned to-dos\n"
      + "• /review — request review on Basecamp\n\n"
      + "• /help — show this menu";

    // Handle /start and /help
    if (text === "/start" || text === "/help") {
      await sendTelegram(helpMsg);
      return res.send("OK");
    }

    // Handle /issues_assigned (specifically requested name)
    if (text === "/issues_assigned" || text === "/issues-assigned-to-me" || text === "/issues") {
      const issues = await ghAPI("/repos/travelxp/foodxp-cms/issues?assignee=AnishTxp&state=open");
      const filtered = issues.filter(i => !i.pull_request);
      if (filtered.length === 0) {
        await sendTelegram("No open issues assigned to you.");
        return res.send("OK");
      }
      const list = filtered.map(i => {
        const labels = i.labels.map(l => l.name).join(", ");
        return "• #" + i.number + " — " + i.title + (labels ? " [" + labels + "]" : "");
      }).join("\n");
      await sendTelegram("📋 " + filtered.length + " issues assigned to you:\n\n" + list + "\n\nSend #number for details.");
      return res.send("OK");
    }

    // Handle /issues <repo>
    if (text.startsWith("/issues ")) {
      let repo = text.split(" ")[1];
      if (!repo.includes("/")) repo = "travelxp/" + repo;
      
      const issues = await ghAPI("/repos/" + repo + "/issues?state=open");
      if (issues.message === "Not Found") {
        await sendTelegram("Repository <code>" + repo + "</code> not found.");
        return res.send("OK");
      }
      
      const filtered = Array.isArray(issues) ? issues.filter(i => !i.pull_request).slice(0, 15) : [];
      if (filtered.length === 0) {
        await sendTelegram("No open issues found in " + repo);
        return res.send("OK");
      }
      
      const list = filtered.map(i => "• #" + i.number + " — " + i.title).join("\n");
      await sendTelegram("📂 <b>" + repo + "</b> Issues:\n\n" + list + (issues.length > 15 ? "\n\n<i>Showing top 15...</i>" : ""));
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

    // Handle /bc_todos
    if (text === "/bc_todos") {
      if (!BC_TOKEN) return await sendTelegram("Basecamp Token not configured on Render.");
      const todos = await bcAPI("/my/todos.json");
      if (!Array.isArray(todos) || todos.length === 0) {
        await sendTelegram("✅ No pending Basecamp to-dos!");
        return res.send("OK");
      }
      const list = todos.slice(0, 10).map(t => "• " + t.content + " (" + t.bucket.name + ")").join("\n");
      await sendTelegram("📝 <b>Your Basecamp To-Dos:</b>\n\n" + list + (todos.length > 10 ? "\n\n<i>Showing top 10...</i>" : ""));
      return res.send("OK");
    }

    // Handle /bc_projects
    if (text === "/bc_projects") {
      const projects = await bcAPI("/projects.json");
      if (!Array.isArray(projects) || projects.length === 0) {
        await sendTelegram("📂 No Basecamp projects found.");
        return res.send("OK");
      }
      const list = projects.map(p => "• " + p.name + " (ID: " + p.id + ")").join("\n");
      await sendTelegram("📂 <b>Basecamp Projects:</b>\n\n" + list);
      return res.send("OK");
    }

    // Handle /review
    if (text === "/review") {
      const projects = await bcAPI("/projects.json");
      if (!Array.isArray(projects) || projects.length === 0) return await sendTelegram("No Basecamp projects found.");
      
      const buttons = projects.slice(0, 10).map(p => ([{ text: p.name, callback_data: "rv_p:" + p.id }]));
      await sendTelegram("📋 Select a Basecamp group/project to post the review request:", {
        reply_markup: { inline_keyboard: buttons }
      });
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
      const body = issue.body || "No description provided.";
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
