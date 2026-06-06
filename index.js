const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// ── Firebase ──
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});
const db = admin.firestore();

// ── Config ──
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ── In-memory session store ──
// In production replace with Firestore or Redis
const sessions = {};

// ── Send WhatsApp message ──
async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );
}

// ── Webhook verification ──
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// ── Webhook handler ──
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // always ack immediately

  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  if (!message || message.type !== "text") return;

  const from = message.from; // phone number
  const text = message.text.body.trim();

  await handleMessage(from, text);
});

// ── Session helper ──
function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { step: "start" };
  return sessions[phone];
}

// ── Main conversation handler ──
async function handleMessage(phone, text) {
  const session = getSession(phone);
  const input = text.toLowerCase();

  // ── Check if already registered ──
  if (session.step === "start") {
    const userSnap = await db.collection("users")
      .where("phone", "==", `+${phone}`).limit(1).get();

    if (!userSnap.empty) {
      const user = userSnap.docs[0].data();
      session.uid = userSnap.docs[0].id;
      session.role = user.role;
      session.name = user.name;
      session.step = "menu";
      await showMenu(phone, session);
      return;
    }

    // New user
    session.step = "choose_role";
    await sendMessage(phone,
      `👋 Welcome to *Fetcha* — SA's auto parts marketplace!\n\nAre you a:\n1️⃣ Buyer — looking for parts\n2️⃣ Supplier — selling parts\n\nReply with *1* or *2*`
    );
    return;
  }

  // ── Role selection ──
  if (session.step === "choose_role") {
    if (input === "1" || input === "buyer") {
      session.role = "buyer";
      session.step = "get_name";
      await sendMessage(phone, "Great! What's your name?");
    } else if (input === "2" || input === "supplier") {
      session.role = "supplier";
      session.step = "get_name";
      await sendMessage(phone, "Great! What's your business name?");
    } else {
      await sendMessage(phone, "Please reply with *1* for Buyer or *2* for Supplier.");
    }
    return;
  }

  // ── Get name ──
  if (session.step === "get_name") {
    session.name = text;
    session.step = "get_address";
    await sendMessage(phone, `Nice to meet you, ${text}! 📍 What's your area or address? (e.g. Sandton, JHB)`);
    return;
  }

  // ── Get address ──
  if (session.step === "get_address") {
    session.address = text;
    session.step = "saving";

    // Save to Firestore
    const userRef = db.collection("users").doc();
    await userRef.set({
      role: session.role,
      name: session.name,
      address: session.address,
      phone: `+${phone}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdVia: "whatsapp",
    });
    session.uid = userRef.id;
    session.step = "menu";

    await sendMessage(phone,
      `✅ You're registered on Fetcha!\n\n*Name:* ${session.name}\n*Area:* ${session.address}\n*Role:* ${session.role === "buyer" ? "Buyer 🚗" : "Supplier 🔧"}`
    );
    await showMenu(phone, session);
    return;
  }

  // ── Main menu ──
  if (session.step === "menu") {
    if (session.role === "buyer") {
      if (input === "1") {
        session.step = "post_make";
        await sendMessage(phone, "What's the *make* of your vehicle? (e.g. Toyota, BMW, Ford)");
      } else if (input === "2") {
        session.step = "menu";
        await showMenu(phone, session);
      } else {
        await showMenu(phone, session);
      }
    } else {
      if (input === "1") {
        session.step = "inv_make";
        await sendMessage(phone, "What's the *make* of the vehicle for the part? (e.g. Toyota)");
      } else if (input === "2") {
        await showOpenRequests(phone, session);
      } else {
        await showMenu(phone, session);
      }
    }
    return;
  }

  // ── BUYER: Post request flow ──
  if (session.step === "post_make") {
    session.postMake = text;
    session.step = "post_model";
    await sendMessage(phone, `Model? (e.g. Hilux, Corolla)`);
    return;
  }
  if (session.step === "post_model") {
    session.postModel = text;
    session.step = "post_year";
    await sendMessage(phone, `Year? (e.g. 2019)`);
    return;
  }
  if (session.step === "post_year") {
    session.postYear = text;
    session.step = "post_part";
    await sendMessage(phone, `What part do you need? (e.g. gearbox, alternator, bumper)`);
    return;
  }
  if (session.step === "post_part") {
    session.postPart = text;
    session.step = "post_desc";
    await sendMessage(phone, `Any extra details? (condition, spec, part number) — or reply *skip*`);
    return;
  }
  if (session.step === "post_desc") {
    session.postDesc = input === "skip" ? "" : text;
    session.step = "post_price";
    await sendMessage(phone, `What's your budget? (e.g. R2500)`);
    return;
  }
  if (session.step === "post_price") {
    session.postPrice = text.replace(/[^0-9]/g, "");
    session.step = "post_loc";
    await sendMessage(phone, `Your location? (e.g. Johannesburg)`);
    return;
  }
  if (session.step === "post_loc") {
    session.postLoc = text;

    // Save to Firestore posts collection
    const postRef = db.collection("posts").doc();
    await postRef.set({
      make: session.postMake,
      model: session.postModel,
      year: session.postYear,
      title: session.postPart,
      desc: session.postDesc,
      price: session.postPrice,
      loc: session.postLoc,
      buyerId: session.uid,
      buyerName: session.name,
      type: "part",
      intent: "request",
      status: "open",
      resp: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdVia: "whatsapp",
    });

    session.step = "menu";
    await sendMessage(phone,
      `✅ *Request posted!*\n\n🚗 ${session.postYear} ${session.postMake} ${session.postModel}\n🔧 ${session.postPart}\n💰 R${session.postPrice}\n📍 ${session.postLoc}\n\nSuppliers in your area will be notified. We'll message you when someone responds!`
    );
    await showMenu(phone, session);
    return;
  }

  // ── SUPPLIER: Add inventory flow ──
  if (session.step === "inv_make") {
    session.invMake = text;
    session.step = "inv_model";
    await sendMessage(phone, `Model?`);
    return;
  }
  if (session.step === "inv_model") {
    session.invModel = text;
    session.step = "inv_year";
    await sendMessage(phone, `Year?`);
    return;
  }
  if (session.step === "inv_year") {
    session.invYear = text;
    session.step = "inv_part";
    await sendMessage(phone, `What part do you stock? (e.g. gearbox, engine, alternator)`);
    return;
  }
  if (session.step === "inv_part") {
    session.invPart = text;
    session.step = "inv_cond";
    await sendMessage(phone, `Condition?\n1️⃣ OEM New\n2️⃣ Aftermarket\n3️⃣ Recon\n4️⃣ Used\n5️⃣ Scrap\n\nReply with a number.`);
    return;
  }
  if (session.step === "inv_cond") {
    const condMap = { "1":"oem","2":"afm","3":"rec","4":"use","5":"scr" };
    session.invCond = condMap[input] || "use";
    session.step = "inv_saving";

    // Save to Firestore inventory collection
    await db.collection("inventory").add({
      make: session.invMake,
      model: session.invModel,
      year: session.invYear,
      title: session.invPart,
      cat: "other",
      cond: [session.invCond],
      sellerId: session.uid,
      sellerName: session.name,
      sellerAddress: session.address,
      type: "part",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdVia: "whatsapp",
    });

    session.step = "menu";
    await sendMessage(phone,
      `✅ *Part added to your inventory!*\n\n${session.invYear} ${session.invMake} ${session.invModel} — ${session.invPart}\n\nFetcha will notify you when a buyer requests this part.`
    );
    await showMenu(phone, session);
    return;
  }

  // Fallback
  await showMenu(phone, session);
}

// ── Show menu ──
async function showMenu(phone, session) {
  if (session.role === "buyer") {
    await sendMessage(phone,
      `*Fetcha Menu* 🚗\n\n1️⃣ Post a part request\n2️⃣ Refresh menu\n\nReply with a number.`
    );
  } else {
    await sendMessage(phone,
      `*Fetcha Menu* 🔧\n\n1️⃣ Add part to inventory\n2️⃣ View open requests\n\nReply with a number.`
    );
  }
}

// ── Show open requests to supplier ──
async function showOpenRequests(phone, session) {
  const snap = await db.collection("posts")
    .where("intent", "==", "request")
    .where("status", "in", ["open", "matched"])
    .orderBy("createdAt", "desc")
    .limit(5)
    .get();

  if (snap.empty) {
    await sendMessage(phone, "No open requests right now. Check back soon!");
    session.step = "menu";
    await showMenu(phone, session);
    return;
  }

  let msg = `*Latest Buyer Requests* 🔍\n\n`;
  snap.forEach((d, i) => {
    const p = d.data();
    msg += `*${i + 1}.* ${p.year} ${p.make} ${p.model} — ${p.title}\n💰 R${p.price} · 📍 ${p.loc}\n\n`;
  });
  msg += `Reply with a number to respond, or *menu* to go back.`;

  session.pendingRequests = [];
  snap.forEach(d => session.pendingRequests.push({ id: d.id, ...d.data() }));
  session.step = "select_request";

  await sendMessage(phone, msg);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fetcha WhatsApp bot running on port ${PORT}`));