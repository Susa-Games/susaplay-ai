// Game names, build notes and filenames are written by developers and reach the
// model through tool results. They are data: control characters are stripped and
// long values are cut, so nothing in them can pass for structure or flood the
// context.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

export function cleanText(value: unknown, maxLength = 200): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(CONTROL, "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
