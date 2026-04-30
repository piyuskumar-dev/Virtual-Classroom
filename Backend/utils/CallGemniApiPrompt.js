require("dotenv").config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash-exp";

/**
 * Calls Google Gemini API with proper error handling and quota management.
 * @param {string} prompt - The prompt to send to Gemini
 * @param {string} [systemInstruction] - Optional system instruction override
 * @returns {Promise<string|null>} The generated text response
 */
async function callGeminiAPI(prompt, systemInstruction = null, fileBuffer = null, mimeType = "application/pdf") {
    if (typeof fetch !== "function") {
        throw new Error("Use Node.js 18+ or add a fetch polyfill.");
    }

    if (!GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY not configured");
    }

    if (!prompt || prompt.trim().length === 0) {
        throw new Error("Prompt cannot be empty");
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
            system_instruction: {
                parts: [
                    {
                        text: systemInstruction ||
                            "You are a helpful teaching assistant that provides constructive, structured feedback.",
                    },
                ],
            },
            contents: [
                {
                    role: "user",
                    parts: [
                        ...(fileBuffer ? [{
                            inlineData: {
                                mimeType: mimeType,
                                data: fileBuffer.toString("base64"),
                            }
                        }] : []),
                        { text: prompt },
                    ],
                },
            ],
            generationConfig: {
                temperature: 0.3,
                topP: 0.8,
                maxOutputTokens: 2048,
                responseMimeType: "application/json",
            },
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        const status = response.status;

        // Detect quota/rate limit errors
        if (status === 429 || errorText.includes('quota') || errorText.includes('rate limit')) {
            const error = new Error("Gemini API quota exhausted");
            error.isQuotaError = true;
            error.statusCode = status;
            throw error;
        }

        throw new Error(`Gemini API error (${status}): ${errorText}`);
    }

    const data = await response.json();

    // Handle API response structure
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? text.trim() : null;
}

module.exports = { callGeminiAPI };