const JSON5 = require("json5");
const { callGeminiAPI } = require("../utils/CallGemniApiPrompt");

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function mockEvaluate({ assignmentTitle, assignmentPrompt, studentAnswerText }) {
  const len = String(studentAnswerText || "").trim().length;
  const score = clamp(Math.round((len / 800) * 10), 0, 10);

  const feedback = [
    `Task: ${assignmentTitle || "Assignment"}`,
    score >= 7
      ? "Good attempt. Your submission is reasonably complete."
      : "Your submission looks incomplete. Add more explanation and show steps.",
    assignmentPrompt
      ? "Make sure you answer the specific points asked in the prompt."
      : "Make sure you answer the assignment requirements clearly.",
  ].join("\n");

  return { score, feedback };
}

async function geminiEvaluate({ assignmentTitle, assignmentPrompt, studentAnswerText, studentBuffer, mimeType }) {
  const prompt = `
You are a strict but fair teacher.

Evaluate the STUDENT SOLUTION against the ASSIGNMENT PROMPT.

Scoring Rules:
- Accuracy (0-5)
- Completeness (0-3)
- Clarity (0-2)

Return ONLY valid JSON:
{
  "score": <number 0-10>,
  "feedback": "<detailed constructive feedback>"
}

ASSIGNMENT TITLE:
${assignmentTitle || ""}

ASSIGNMENT PROMPT:
${assignmentPrompt || ""}

STUDENT SOLUTION:
${studentAnswerText || (studentBuffer ? "Attached as file." : "")}
`;

  const raw = await callGeminiAPI(prompt, null, studentBuffer, mimeType);
  const clean = String(raw || "").replace(/```json|```/g, "").trim();
  const jsonMatch = clean.match(/\{[\s\S]*\}/);

  try {
    const parsed = JSON5.parse(jsonMatch ? jsonMatch[0] : clean);

    const score =
      typeof parsed.score === "number" ? clamp(parsed.score, 0, 10) : 0;

    const feedback =
      typeof parsed.feedback === "string"
        ? parsed.feedback
        : "No feedback generated.";

    return { score, feedback };
  } catch (err) {
    console.error("JSON parse failed:", err.message);
    return mockEvaluate({ assignmentTitle, assignmentPrompt, studentAnswerText });
  }
}

async function evaluateSolution(payload) {
  const hasGemini = !!process.env.GEMINI_API_KEY;

  if (!hasGemini) return mockEvaluate(payload);

  try {
    return await geminiEvaluate(payload);
  } catch (err) {
    console.error("AI evaluation failed:", err?.message || err);
    return mockEvaluate(payload);
  }
}

module.exports = { evaluateSolution };