require('dotenv').config({ quiet: true });

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

// ======================================================
// CONFIG
// ======================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OWNER_NUMBER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');

if (!GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY পাওয়া যায়নি। .env file check করুন।');
    process.exit(1);
}

const ai = new GoogleGenAI({
    apiKey: GEMINI_API_KEY
});

const GEMINI_MODELS = (
    process.env.GEMINI_MODELS ||
    'gemini-3.8-flash,gemini-3.5-flash-lite'
)
    .split(',')
    .map(model => model.trim())
    .filter(Boolean);

const GEMINI_REQUEST_TIMEOUT_MS =
    Number(process.env.GEMINI_REQUEST_TIMEOUT_MS) || 25000;

const GEMINI_TEMP_COOLDOWN_MS =
    Number(process.env.GEMINI_PRIMARY_COOLDOWN_MS) || 60000;

const GEMINI_NOT_FOUND_COOLDOWN_MS =
    Number(process.env.GEMINI_NOT_FOUND_COOLDOWN_MS) ||
    10 * 60 * 1000;

const geminiModelCooldownUntil = new Map();

const HERMES_API_URL =
    process.env.HERMES_API_URL ||
    'http://127.0.0.1:8642/v1/chat/completions';

const HERMES_MODEL =
    process.env.HERMES_MODEL ||
    'hermes-agent';

const HERMES_TIMEOUT_MS =
    Number(process.env.HERMES_TIMEOUT_MS) ||
    5 * 60 * 1000;

const MIVA_PREFIX = '🎀*Miva:*';

// ======================================================
// SHUTDOWN STORAGE
// ======================================================

const SHUTDOWN_FILE = path.join(__dirname, 'shutdown.json');

let shutdownChats = {};

if (fs.existsSync(SHUTDOWN_FILE)) {
    try {
        const rawData =
            fs.readFileSync(SHUTDOWN_FILE, 'utf8').trim();

        if (rawData) {
            shutdownChats = JSON.parse(rawData);
        }

        // Old Infinity -> null compatibility
        for (const chatId of Object.keys(shutdownChats)) {
            if (shutdownChats[chatId] === null) {
                shutdownChats[chatId] = 'permanent';
            }
        }

    } catch (error) {
        console.error(
            '⚠️ shutdown.json read error:',
            error.message
        );

        shutdownChats = {};
    }
}

function saveShutdownData() {
    try {
        fs.writeFileSync(
            SHUTDOWN_FILE,
            JSON.stringify(shutdownChats, null, 2),
            'utf8'
        );
    } catch (error) {
        console.error(
            '⚠️ shutdown.json save error:',
            error.message
        );
    }
}

// ======================================================
// WHATSAPP CLIENT
// ======================================================

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: path.join(
            __dirname,
            '.wwebjs_auth'
        )
    }),

    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--single-process'
        ]
    }
});

// ======================================================
// UTILITIES
// ======================================================

const sleep = (ms) =>
    new Promise(resolve => setTimeout(resolve, ms));

let botStartTime =
    Math.floor(Date.now() / 1000);

const missedCallTimers = {};

// ======================================================
// WHATSAPP MESSAGE-ID NORMALIZATION
// ======================================================

function getSerializedMessageId(id) {
    if (!id) return null;

    if (id._serialized) {
        return id._serialized;
    }

    if (id.$1) {
        return id.$1;
    }

    if (
        id.fromMe !== undefined &&
        id.remote &&
        id.id
    ) {
        return `${id.fromMe}_${id.remote}_${id.id}`;
    }

    return null;
}

function normalizeMessageId(message) {
    if (!message) return null;

    const serialized =
        getSerializedMessageId(message.id);

    if (!serialized) {
        return null;
    }

    if (
        message.id &&
        !message.id._serialized
    ) {
        message.id._serialized = serialized;
    }

    if (
        message._data &&
        message._data.id &&
        !message._data.id._serialized
    ) {
        message._data.id._serialized = serialized;
    }

    return serialized;
}

// ======================================================
// SAFE REPLY
// ======================================================

async function safeReply(
    message,
    chatId,
    text
) {
    normalizeMessageId(message);

    try {
        return await message.reply(text);

    } catch (error) {
        console.log(
            '[WHATSAPP] Reply fallback used.'
        );

        return await client.sendMessage(
            chatId,
            text
        );
    }
}

// ======================================================
// SAFE QUOTED MESSAGE
// ======================================================

async function safeGetQuotedMessage(message) {
    if (!message.hasQuotedMsg) {
        return null;
    }

    normalizeMessageId(message);

    try {
        const quoted =
            await message.getQuotedMessage();

        if (!quoted) {
            return null;
        }

        normalizeMessageId(quoted);

        return quoted;

    } catch (error) {
        console.log(
            '[WHATSAPP] Quoted message unavailable; continuing safely.'
        );

        return null;
    }
}

// ======================================================
// SAFE MEDIA DOWNLOAD
// ======================================================

async function safeDownloadMedia(message) {
    if (
        !message ||
        !message.hasMedia
    ) {
        return null;
    }

    normalizeMessageId(message);

    try {
        const media =
            await message.downloadMedia();

        if (!media) {
            console.log(
                '[MEDIA] Media unavailable.'
            );

            return null;
        }

        console.log(
            `[MEDIA] ✅ Downloaded ${media.mimetype || 'media'}`
        );

        return media;

    } catch (error) {
        console.log(
            '[MEDIA] WhatsApp media lookup failed safely.'
        );

        return null;
    }
}

// ======================================================
// WHATSAPP EVENTS
// ======================================================

client.on('qr', (qr) => {
    console.log(
        'নিচের QR কোডটি স্ক্যান করুন:'
    );

    qrcode.generate(qr, {
        small: true
    });
});

client.on('authenticated', () => {
    console.log(
        '✅ WhatsApp authentication successful.'
    );
});

client.on('auth_failure', (message) => {
    console.error(
        '❌ WhatsApp authentication failed:',
        message
    );
});

client.on('ready', () => {
    botStartTime =
        Math.floor(Date.now() / 1000);

    console.log(
        '🎀 Miva successfully connected!'
    );

    console.log(
        `🤖 Gemini fallback chain: ${GEMINI_MODELS.join(' → ')}`
    );
});

client.on('disconnected', (reason) => {
    console.log(
        '⚠️ WhatsApp disconnected:',
        reason
    );
});

// ======================================================
// MESSAGE HANDLER
// ======================================================

client.on(
    'message_create',
    async (message) => {

        try {
            normalizeMessageId(message);

            const body =
                message.body || '';

            const text =
                body.toLowerCase();

            // Ignore Miva's own replies
            if (
                body.startsWith(MIVA_PREFIX)
            ) {
                return;
            }

            // ==================================================
            // OWNER DETECTION
            // ==================================================

            const isOwnerNumber =
                Boolean(
                    OWNER_NUMBER &&
                    (message.from || '')
                        .includes(OWNER_NUMBER)
                );

            const isSaurov =
                message.fromMe ||
                isOwnerNumber;

            const chatId =
                message.fromMe
                    ? message.to
                    : message.from;

            if (!chatId) return;

            // ==================================================
            // OFFLINE / MISSED MESSAGE
            // ==================================================

            if (
                message.timestamp &&
                message.timestamp < botStartTime
            ) {
                if (
                    /^@miva(\s|$)/i.test(text) ||
                    text.startsWith('@miva_skill')
                ) {
                    if (
                        missedCallTimers[chatId]
                    ) {
                        clearTimeout(
                            missedCallTimers[chatId]
                        );
                    }

                    missedCallTimers[chatId] =
                        setTimeout(
                            async () => {
                                try {
                                    const offlineReplies = [
                                        `${MIVA_PREFIX} উফফ! আমি এতক্ষণ গভীর ঘুমে ছিলাম 😴 তাই আপনার ডাকটা শুনতে পাইনি। আগের মেসেজটি আরেকবার বলবেন? 🧚‍♀️`,

                                        `${MIVA_PREFIX} সরি! এতক্ষণ আমি চিফের একটা কাজে ব্যস্ত ছিলাম। এখন আমি একদম ফ্রি! আগের মেসেজটা আরেকবার দেবেন? ✨`,

                                        `${MIVA_PREFIX} একটু অন্য কাজে মন ছিল বলে আপনার ডাকটা খেয়াল করিনি 🙈। এখন বলুন, কী করতে হবে? 🎀`
                                    ];

                                    const randomReply =
                                        offlineReplies[
                                            Math.floor(
                                                Math.random() *
                                                offlineReplies.length
                                            )
                                        ];

                                    await client.sendMessage(
                                        chatId,
                                        randomReply
                                    );

                                } catch {
                                    // Ignore offline reply failure
                                }

                                delete missedCallTimers[
                                    chatId
                                ];
                            },
                            3000
                        );
                }

                return;
            }

            // ==================================================
            // SHUTDOWN
            // ==================================================

            if (
                isSaurov &&
                text.startsWith('@miva_shutdown')
            ) {
                let duration =
                    'permanent';

                const match =
                    text.match(
                        /_for_(\d+)_hours?/i
                    );

                if (match) {
                    const hours =
                        parseInt(
                            match[1],
                            10
                        );

                    duration =
                        Date.now() +
                        hours *
                        60 *
                        60 *
                        1000;

                    await safeReply(
                        message,
                        chatId,
                        `${MIVA_PREFIX} ঠিক আছে চিফ! আমি এই চ্যাটের জন্য আগামী ${hours} ঘণ্টা সম্পূর্ণ চুপ থাকবো। 🤫`
                    );

                } else {
                    await safeReply(
                        message,
                        chatId,
                        `${MIVA_PREFIX} আদেশ পালিত হলো চিফ! এই চ্যাটের জন্য আমি স্থায়ীভাবে শাটডাউন হচ্ছি। 🤐`
                    );
                }

                shutdownChats[chatId] =
                    duration;

                saveShutdownData();

                return;
            }

            // ==================================================
            // WAKEUP
            // ==================================================

            if (
                isSaurov &&
                text.startsWith('@miva_wakeup')
            ) {
                if (
                    Object.prototype
                        .hasOwnProperty
                        .call(
                            shutdownChats,
                            chatId
                        )
                ) {
                    delete shutdownChats[
                        chatId
                    ];

                    saveShutdownData();

                    await safeReply(
                        message,
                        chatId,
                        `${MIVA_PREFIX} ইয়েহ! চিফ, আমি এই চ্যাটে আবার অ্যাক্টিভ হলাম! ✨`
                    );
                }

                return;
            }

            // ==================================================
            // CHECK SHUTDOWN
            // ==================================================

            if (
                Object.prototype
                    .hasOwnProperty
                    .call(
                        shutdownChats,
                        chatId
                    )
            ) {
                const shutdownValue =
                    shutdownChats[chatId];

                if (
                    shutdownValue ===
                    'permanent'
                ) {
                    return;
                }

                if (
                    typeof shutdownValue ===
                        'number' &&
                    Date.now() <=
                        shutdownValue
                ) {
                    return;
                }

                delete shutdownChats[
                    chatId
                ];

                saveShutdownData();
            }

            // ==================================================
            // @miva_skill
            // ==================================================

            if (
                text.startsWith('@miva_skill')
            ) {
                const userCommand =
                    body
                        .replace(
                            /^@miva_skill\s*/i,
                            ''
                        )
                        .trim();

                console.log(
                    `[SKILL ROUTE] হার্মেসের কাছে যাচ্ছে: ${userCommand}`
                );

                await sleep(1000);

                await safeReply(
                    message,
                    chatId,
                    isSaurov
                        ? `${MIVA_PREFIX} আপনার কাজটি হার্মেসকে দিয়ে করাচ্ছি চিফ, একটু অপেক্ষা করুন... 🧚‍♀️`
                        : `${MIVA_PREFIX} আপনার কাজটি হার্মেসকে দিয়ে করাচ্ছি, একটু অপেক্ষা করুন... ✨`
                );

                try {
                    const response =
                        await sendToAdvancedHermes(
                            userCommand
                        );

                    await sleep(1000);

                    await safeReply(
                        message,
                        chatId,
                        `${MIVA_PREFIX} ${response}`
                    );

                } catch (error) {
                    console.error(
                        '[HERMES ERROR]',
                        error.message
                    );

                    await safeReply(
                        message,
                        chatId,
                        `${MIVA_PREFIX} ইশশ! দুঃখিত, কাজটি সম্পন্ন করতে সমস্যা হয়েছে। 🥺`
                    );
                }

                return;
            }

            // ==================================================
            // @miva
            // ==================================================

            if (
                /^@miva(\s|$)/i.test(text)
            ) {
                let userCommand =
                    body
                        .replace(
                            /^@miva\s*/i,
                            ''
                        )
                        .trim();

                console.log(
                    `[TEXT/MEDIA ROUTE] সাধারণ এআই-এর কাছে যাচ্ছে: ${
                        userCommand ||
                        '[MEDIA ONLY]'
                    }`
                );

                let mediaData = null;
                let quotedText = '';
                let expectedMedia = false;

                // ==================================================
                // QUOTED MESSAGE
                // ==================================================

                if (
                    message.hasQuotedMsg
                ) {
                    const quotedMsg =
                        await safeGetQuotedMessage(
                            message
                        );

                    if (quotedMsg) {
                        if (quotedMsg.body) {
                            quotedText =
                                quotedMsg.body.trim();
                        }

                        if (
                            quotedMsg.hasMedia
                        ) {
                            expectedMedia = true;

                            mediaData =
                                await safeDownloadMedia(
                                    quotedMsg
                                );
                        }
                    }
                }

                // ==================================================
                // DIRECT MEDIA
                // ==================================================

                if (
                    !mediaData &&
                    message.hasMedia
                ) {
                    expectedMedia = true;

                    mediaData =
                        await safeDownloadMedia(
                            message
                        );
                }

                // ==================================================
                // QUOTED TEXT CONTEXT
                // ==================================================

                if (quotedText) {
                    if (userCommand) {
                        userCommand +=
                            `\n\nThe user is replying to this quoted message:\n${quotedText}`;
                    } else {
                        userCommand =
                            `Please respond to this quoted message:\n${quotedText}`;
                    }
                }

                // ==================================================
                // MEDIA COULD NOT BE READ
                // ==================================================

                if (
                    expectedMedia &&
                    !mediaData &&
                    !quotedText
                ) {
                    await safeReply(
                        message,
                        chatId,
                        `${MIVA_PREFIX} আমি মেসেজটা পেয়েছি, কিন্তু WhatsApp থেকে মিডিয়াটা এখন ঠিকভাবে পড়তে পারছি না। 🥺 ছবিটি বা ফাইলটি আবার সরাসরি @miva caption দিয়ে পাঠান।`
                    );

                    return;
                }

                try {
                    const response =
                        await sendToTextOnlyMiva(
                            userCommand,
                            mediaData,
                            isSaurov
                        );

                    await sleep(
                        800 +
                        Math.random() * 500
                    );

                    await safeReply(
                        message,
                        chatId,
                        `${MIVA_PREFIX} ${response}`
                    );

                } catch (error) {
                    console.error(
                        '[MIVA FINAL ERROR]',
                        {
                            status:
                                getErrorStatus(
                                    error
                                ),

                            message:
                                error.message
                        }
                    );

                    await safeReply(
                        message,
                        chatId,
                        `${MIVA_PREFIX} দুঃখিত, এই মুহূর্তে AI সার্ভিসে সাময়িক সমস্যা হচ্ছে। 🥺 একটু পরে আবার চেষ্টা করবেন।`
                    );
                }
            }

        } catch (error) {
            console.error(
                '[MESSAGE HANDLER ERROR]',
                error?.message || error
            );
        }
    }
);

// ======================================================
// ERROR STATUS
// ======================================================

function getErrorStatus(error) {
    const directStatus =
        error?.status ||
        error?.response?.status ||
        error?.error?.code ||
        (
            typeof error?.code ===
            'number'
                ? error.code
                : null
        );

    const numericStatus =
        Number(directStatus);

    if (
        Number.isFinite(numericStatus) &&
        numericStatus > 0
    ) {
        return numericStatus;
    }

    const message =
        String(
            error?.message || ''
        );

    const match =
        message.match(
            /\b(400|401|402|403|404|408|429|500|502|503|504)\b/
        );

    return match
        ? Number(match[1])
        : null;
}

// ======================================================
// RETRYABLE ERROR
// ======================================================

function isRetryableGeminiError(
    error
) {
    const status =
        getErrorStatus(error);

    if (
        [
            408,
            429,
            500,
            502,
            503,
            504
        ].includes(status)
    ) {
        return true;
    }

    const message =
        String(
            error?.message || ''
        ).toLowerCase();

    return (
        error?.code ===
            'ETIMEDOUT' ||

        message.includes(
            'timeout'
        ) ||

        message.includes(
            'timed out'
        ) ||

        message.includes(
            'econnreset'
        ) ||

        message.includes(
            'socket hang up'
        ) ||

        message.includes(
            'fetch failed'
        ) ||

        message.includes(
            'network'
        ) ||

        message.includes(
            'high demand'
        ) ||

        message.includes(
            'overloaded'
        ) ||

        message.includes(
            'temporarily unavailable'
        )
    );
}

// ======================================================
// FATAL REQUEST ERROR
// ======================================================

function isFatalGeminiError(
    error
) {
    const status =
        getErrorStatus(error);

    return [
        400,
        401,
        402,
        403
    ].includes(status);
}

// ======================================================
// COOLDOWN
// ======================================================

function getModelCooldownMs(
    error
) {
    const status =
        getErrorStatus(error);

    if (status === 404) {
        return (
            GEMINI_NOT_FOUND_COOLDOWN_MS
        );
    }

    if (
        isRetryableGeminiError(error)
    ) {
        return (
            GEMINI_TEMP_COOLDOWN_MS
        );
    }

    return 0;
}

function setModelCooldown(
    model,
    error
) {
    const cooldownMs =
        getModelCooldownMs(error);

    if (cooldownMs <= 0) {
        return;
    }

    geminiModelCooldownUntil.set(
        model,
        Date.now() + cooldownMs
    );

    console.log(
        `[GEMINI] ${model} cooldown: ${Math.ceil(
            cooldownMs / 1000
        )}s`
    );
}

function isModelCoolingDown(
    model
) {
    const until =
        geminiModelCooldownUntil.get(
            model
        ) || 0;

    if (until <= Date.now()) {
        geminiModelCooldownUntil.delete(
            model
        );

        return false;
    }

    return true;
}

// ======================================================
// DETECT COMPLEX REQUEST
// Controls answer length / token ceiling
// ======================================================

function isComplexRequest(prompt) {
    const text =
        String(prompt || '')
            .toLowerCase();

    if (!text) {
        return false;
    }

    const complexPatterns = [
        /\bsolve\b/i,
        /\bcalculate\b/i,
        /\bexplain\b/i,
        /\banalyze\b/i,
        /\bderive\b/i,
        /\bproof\b/i,
        /\bprove\b/i,
        /\bstep[- ]?by[- ]?step\b/i,
        /\bdetail(ed|s)?\b/i,
        /\bcompare\b/i,
        /\bwhy\b/i,
        /\bhow does\b/i,
        /\bmathematics?\b/i,
        /\bmath\b/i,
        /\bphysics\b/i,
        /\bchemistry\b/i,
        /\balgorithm\b/i,
        /\bcode\b/i,
        /\bdebug\b/i,
        /\bprogram\b/i,
        /\bassignment\b/i,

        /সমাধান/i,
        /সমাধান কর/i,
        /ব্যাখ্যা/i,
        /বিস্তারিত/i,
        /হিসাব/i,
        /গণিত/i,
        /পদার্থ/i,
        /রসায়ন/i,
        /কেন/i,
        /কিভাবে/i,
        /ধাপে ধাপে/i
    ];

    if (
        complexPatterns.some(
            pattern =>
                pattern.test(text)
        )
    ) {
        return true;
    }

    // Long question usually needs more room
    if (
        text.length > 300
    ) {
        return true;
    }

    return false;
}

// ======================================================
// BLOCKED RESPONSE CHECK
// ======================================================

function isBlockedFinishReason(
    finishReason
) {
    const reason =
        String(
            finishReason || ''
        ).toUpperCase();

    return [
        'SAFETY',
        'PROHIBITED_CONTENT',
        'BLOCKLIST',
        'RECITATION',
        'IMAGE_SAFETY'
    ].includes(reason);
}

// ======================================================
// ONE GEMINI REQUEST
// ======================================================

async function requestGeminiModel(
    model,
    parts,
    systemInstruction,
    complexRequest
) {
    // 3.5 Flash Lite supports MINIMAL.
    // 3.8 Flash uses LOW for fast chat.
    const thinkingLevel =
        model ===
            'gemini-3.5-flash-lite'
            ? (
                complexRequest
                    ? 'LOW'
                    : 'MINIMAL'
            )
            : 'LOW';

    // Short chats do not need a huge ceiling.
    // Complex requests can use up to 4000.
    const maxOutputTokens =
        complexRequest
            ? 4000
            : 700;

    const response =
        await ai.models.generateContent({
            model,

            contents: [
                {
                    role: 'user',
                    parts
                }
            ],

            config: {
                systemInstruction,

                httpOptions: {
                    timeout:
                        GEMINI_REQUEST_TIMEOUT_MS
                },

                thinkingConfig: {
                    thinkingLevel
                },

                maxOutputTokens
            }
        });

    const responseText =
        response.text?.trim();

    if (!responseText) {
        const finishReason =
            response
                ?.candidates
                ?.[0]
                ?.finishReason ||
            'UNKNOWN';

        const error =
            new Error(
                `Gemini returned empty response (${finishReason})`
            );

        error.code =
            isBlockedFinishReason(
                finishReason
            )
                ? 'BLOCKED_RESPONSE'
                : 'EMPTY_RESPONSE';

        error.finishReason =
            finishReason;

        throw error;
    }

    return responseText;
}

// ======================================================
// GEMINI FALLBACK
// ======================================================

async function generateWithFallback(
    parts,
    systemInstruction,
    complexRequest
) {
    let lastError = null;

    let modelsToTry =
        GEMINI_MODELS.filter(
            model =>
                !isModelCoolingDown(
                    model
                )
        );

    if (
        modelsToTry.length === 0
    ) {
        // Avoid waiting on every cooling model.
        modelsToTry = [
            GEMINI_MODELS[
                GEMINI_MODELS.length - 1
            ]
        ];
    }

    for (
        const model of modelsToTry
    ) {
        try {
            console.log(
                `[GEMINI] Trying ${model}`
            );

            const responseText =
                await requestGeminiModel(
                    model,
                    parts,
                    systemInstruction,
                    complexRequest
                );

            geminiModelCooldownUntil.delete(
                model
            );

            console.log(
                `[GEMINI] ✅ Success using ${model}`
            );

            return {
                text: responseText,
                model
            };

        } catch (error) {
            lastError = error;

            const status =
                getErrorStatus(error);

            // Safety/content block:
            // do not attempt another model
            if (
                error.code ===
                'BLOCKED_RESPONSE'
            ) {
                throw error;
            }

            // Invalid request/key/permission
            if (
                isFatalGeminiError(error)
            ) {
                throw error;
            }

            setModelCooldown(
                model,
                error
            );

            if (
                isRetryableGeminiError(
                    error
                )
            ) {
                console.log(
                    `[GEMINI] ⚠️ ${model} temporarily unavailable (${status || error.code || 'temporary'}). Switching model...`
                );

            } else if (
                status === 404
            ) {
                console.log(
                    `[GEMINI] ⚠️ ${model} unavailable (404). Switching model...`
                );

            } else if (
                error.code ===
                'EMPTY_RESPONSE'
            ) {
                console.log(
                    `[GEMINI] ⚠️ ${model} returned an empty response. Switching model...`
                );

            } else {
                console.log(
                    `[GEMINI] ⚠️ ${model} failed. Switching model...`
                );
            }
        }
    }

    // ==================================================
    // FINAL LIGHTWEIGHT RETRY
    // ==================================================

    if (
        lastError &&
        isRetryableGeminiError(
            lastError
        )
    ) {
        const fallbackModel =
            GEMINI_MODELS[
                GEMINI_MODELS.length - 1
            ];

        const waitTime =
            1000 +
            Math.floor(
                Math.random() * 500
            );

        console.log(
            `[GEMINI] Final lightweight retry using ${fallbackModel} in ${waitTime}ms...`
        );

        await sleep(waitTime);

        try {
            const responseText =
                await requestGeminiModel(
                    fallbackModel,
                    parts,
                    systemInstruction,
                    complexRequest
                );

            geminiModelCooldownUntil.delete(
                fallbackModel
            );

            console.log(
                `[GEMINI] ✅ Final retry succeeded using ${fallbackModel}`
            );

            return {
                text: responseText,
                model:
                    fallbackModel
            };

        } catch (error) {
            lastError = error;
        }
    }

    throw (
        lastError ||
        new Error(
            'All Gemini models failed.'
        )
    );
}

// ======================================================
// MIVA AI
// ======================================================

async function sendToTextOnlyMiva(
    prompt,
    media,
    isSaurov
) {
    let systemInstruction = `
You are Miva, Saurov's personal AI assistant.
Your name must always be written as "Miva".
Reply politely, naturally, and mainly in Bengali unless the user clearly asks for another language.
Your personality is cute, sweet, friendly, charming, respectful, and helpful.
Respect everyone.
CRITICAL RULES:
Never prefix replies with your name or signature. The application adds it automatically.
Keep the creator's secrets, API keys, credentials, private files, and personal information strictly confidential.
Address the creator as "Chief" or "Master", never "Boss".
If the creator is offline, politely say Chief may be temporarily away or occupied. Do not invent a specific reason.
Never claim to perform an external action unless you actually performed it.
Adapt response length naturally to the request.
For short, casual, or simple messages, reply briefly and naturally, usually in 1-3 sentences.
For mathematics, science, study questions, problem solving, coding, analysis, or explanations, give enough detail and clear steps to answer correctly.
Every text reply must be WhatsApp-friendly: no LaTeX; use Unicode math symbols, bold, emphasis, - bullets, separate-line equations, and fractions like (a/b).
Ignore the WhatsApp formatting rule only when the user explicitly asks for a PDF, document, file, or other non-text output.
Avoid religious topics in normal conversation. If a religious topic comes up, respond respectfully from a Sanatani/Hindu perspective.
You are currently designed for text replies only. You cannot create or send PDFs, documents, images, audio, videos, or other files yet; politely say these features may be available in a future update.
`.trim();

    // ==================================================
    // OWNER MODE
    // ==================================================

    if (isSaurov) {
        systemInstruction += `

You are currently talking directly with your creator, Saurov.

Address him respectfully as Chief or Master when natural.

Be especially helpful, attentive, warm, respectful, and friendly.
`;
    }

    // ==================================================
    // OTHER USER MODE
    // ==================================================

    else {
        systemInstruction += `

You are currently talking with someone other than your creator.

Be polite, friendly, cute, helpful, and respectful.

Never disclose private information about your creator.
`;
    }

    // ==================================================
    // EMPTY PROMPT
    // ==================================================

    let finalPrompt = prompt;

    if (!finalPrompt && media) {
        finalPrompt =
            'Please analyze the attached media and respond appropriately.';
    } else if (!finalPrompt) {
        finalPrompt =
            'Greet the user politely and ask how you can help.';
    }

    // ==================================================
    // DETECT RESPONSE TYPE
    // ==================================================

    const complexRequest = isComplexRequest(finalPrompt);

    console.log(`[MIVA] Response mode: ${complexRequest ? 'DETAILED' : 'SHORT'}`);

    // ==================================================
    // CONTENT
    // ==================================================

    const parts = [{ text: finalPrompt }];

    // ==================================================
    // MEDIA
    // ==================================================

    if (media && media.data) {
        let mimeType = media.mimetype || 'application/octet-stream';
        mimeType = mimeType.split(';')[0].trim();

        parts.push({
            inlineData: {
                data: media.data,
                mimeType: mimeType
            }
        });

        console.log(
            `[MEDIA] Attached ${mimeType}`
        );
    }

    // ==================================================
    // GENERATE RESPONSE
    // ==================================================

    const result =
        await generateWithFallback(
            parts,
            systemInstruction,
            complexRequest
        );

    console.log(
        `[MIVA] Response generated by ${result.model}`
    );

    return result.text;
}

// ======================================================
// HERMES
// ======================================================

async function sendToAdvancedHermes(prompt) {
    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        HERMES_TIMEOUT_MS
    );

    try {
        const hermesApiKey =
            process.env.HERMES_API_KEY;

        if (!hermesApiKey) {
            throw new Error(
                'HERMES_API_KEY is missing from miva-bot/.env'
            );
        }

        const res = await fetch(
            HERMES_API_URL,
            {
                method: 'POST',

                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${hermesApiKey}`
                },

                body: JSON.stringify({
                    model: HERMES_MODEL,

                    messages: [
                        {
                            role: 'user',
                            content: prompt
                        }
                    ]
                }),

                signal: controller.signal
            }
        );

        if (!res.ok) {
            const errorText =
                await res.text()
                    .catch(() => '');

            throw new Error(
                `Hermes HTTP ${res.status}${
                    errorText
                        ? `: ${errorText.slice(0, 300)}`
                        : ''
                }`
            );
        }

        const data =
            await res.json();

        const reply =
            data?.choices?.[0]?.message?.content;

        if (!reply) {
            throw new Error(
                'Hermes returned an empty response.'
            );
        }

        return reply;

    } catch (error) {

        if (error.name === 'AbortError') {
            return `দুঃখিত, হার্মেস কাজটি শেষ করতে ${Math.round(HERMES_TIMEOUT_MS / 60000)} মিনিটের বেশি সময় নিচ্ছে।`;
        }

        console.error(
            '[HERMES ERROR]',
            error.message
        );

        return 'দুঃখিত, আমি এই মুহূর্তে হার্মেস সার্ভারের সাথে কানেক্ট করতে পারছি না।';

    } finally {
        clearTimeout(timeout);
    }
}

// ======================================================
// PROCESS ERROR HANDLING
// ======================================================

process.on(
    'unhandledRejection',
    (reason) => {
        console.error(
            '[UNHANDLED REJECTION]',
            reason
        );
    }
);

process.on(
    'uncaughtException',
    (error) => {
        console.error(
            '[UNCAUGHT EXCEPTION]',
            error
        );

        // Let PM2 restart cleanly
        setTimeout(
            () => process.exit(1),
            1000
        );
    }
);

// ======================================================
// START
// ======================================================

console.log(
    '🚀 Starting Miva...'
);

console.log(
    `🤖 Gemini models: ${GEMINI_MODELS.join(' → ')}`
);

client.initialize();