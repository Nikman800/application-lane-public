// The page markup a report or fill capture keeps for each frame is limited,
// and heavy pages spend that limit on their <head>: Microsoft's careers form
// carried 1.8 million characters of inline
// styles, so the cut fell inside the "Job specific questions" section and the
// saved markup never showed it; TikTok's form lost its whole <body> the same
// way. What the limit keeps is the form: page weight that says nothing about
// it goes first, in order of how little it says, and only then is the markup
// cut, around the form rather than at its end.
export const SNAPSHOT_LIMIT = 2_000_000;

// Room for the notes that say what was left out.
const NOTE_ROOM = 400;

const omitted = (length: number) => `omitted ${length} characters`;

export function boundSnapshotMarkup(html: string, limit = SNAPSHOT_LIMIT): string {
  if (html.length <= limit) return html;
  // Encoded images and fonts, icon path data and script bodies: none of them
  // is form state, and a replay or a fixture rebuilds the form without them.
  let kept = html
    .replace(/data:[^"'\s)&<>]{200,}/g, (uri) => `data:,${omitted(uri.length)}`)
    .replace(/(<path\b[^>]*?\sd=")[^"]{200,}"/g, (_, open: string) => `${open}M0 0"`)
    .replace(
      /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
      (all, open: string, body: string, close: string) =>
        body.length > 200 ? `${open}/* ${omitted(body.length)} */${close}` : all,
    );
  if (kept.length <= limit) return kept;
  // Style sheets, largest first, until the markup fits. A style can hide a
  // control, so the ones that fit stay.
  const styles = [...kept.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1].length)
    .filter((length) => length > 200)
    .sort((a, b) => b - a);
  let excess = kept.length - limit;
  let floor = Infinity;
  for (const length of styles) {
    if (excess <= 0) break;
    floor = length;
    excess -= length - omitted(length).length - 6;
  }
  if (floor !== Infinity)
    kept = kept.replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
      (all, open: string, body: string, close: string) =>
        body.length >= floor ? `${open}/* ${omitted(body.length)} */${close}` : all,
    );
  if (kept.length <= limit) return kept;
  // A long <head> never crowds out the form: it keeps only its title, metas
  // and base, which say what the page is.
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(kept);
  if (head && head[1].length > NOTE_ROOM) {
    const summary = (head[1].match(/<title\b[^>]*>[\s\S]*?<\/title>|<meta\b[^>]*>|<base\b[^>]*>/gi) || [])
      .join("")
      .slice(0, 20_000);
    const open = head[0].slice(0, head[0].length - head[1].length - "</head>".length);
    kept =
      kept.slice(0, head.index) +
      `${open}${summary}<!-- lane: head ${omitted(head[1].length - summary.length)} --></head>` +
      kept.slice(head.index + head[0].length);
  }
  if (kept.length <= limit) return kept;
  // Still too long: keep what comes before the body, and the part of the body
  // around the form, cut at tag boundaries.
  const bodyOpen = /<body\b[^>]*>/i.exec(kept);
  const lead = bodyOpen ? kept.slice(0, Math.min(bodyOpen.index + bodyOpen[0].length, 50_000)) : "";
  const rest = kept.slice(lead.length);
  const budget = Math.max(0, limit - lead.length - NOTE_ROOM);
  const firstForm = rest.search(/<form\b/i);
  const firstControl = rest.search(/<(input|select|textarea|fieldset)\b|role="(radio|radiogroup|combobox|checkbox|listbox|textbox)"/i);
  const starts = [firstForm, firstControl].filter((index) => index >= 0);
  const formStart = starts.length ? Math.min(...starts) : 0;
  const lastClose = rest.toLowerCase().lastIndexOf("</form>");
  const controls = [...rest.matchAll(/<(input|select|textarea)\b/gi)];
  const lastControl = controls.length ? controls[controls.length - 1].index! : -1;
  const formEnd = Math.max(lastClose >= 0 ? lastClose + 7 : 0, lastControl, formStart);
  const span = formEnd - formStart;
  let start =
    span >= budget ? formStart : Math.max(0, formStart - Math.floor((budget - span) / 2));
  let end = Math.min(rest.length, start + budget);
  start = Math.max(0, end - budget);
  if (start > 0) {
    const tag = rest.indexOf("<", start);
    start = tag >= 0 && tag < end ? tag : start;
  }
  if (end < rest.length) {
    const close = rest.lastIndexOf(">", end - 1);
    end = close > start ? close + 1 : end;
  }
  return (
    lead +
    (start > 0 ? `<!-- lane: ${omitted(start)} before the form -->` : "") +
    rest.slice(start, end) +
    (end < rest.length ? `<!-- lane: ${omitted(rest.length - end)} after the form -->` : "")
  );
}
