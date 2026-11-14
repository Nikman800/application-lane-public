import { test } from "node:test";
import assert from "node:assert/strict";
import { boundSnapshotMarkup, SNAPSHOT_LIMIT } from "../src/extension/snapshot-markup";

// As Microsoft's careers form: megabytes of
// inline styles in <head>, and the questions at the end of a long <body>.
const style = (size: number) => `<style>${".c{color:red}".repeat(Math.ceil(size / 12)).slice(0, size)}</style>`;
const question = (n: number) =>
  `<fieldset><legend>Question ${n}</legend><label><input type="radio" name="q${n}" value="Yes">Yes</label><label><input type="radio" name="q${n}" value="No">No</label></fieldset>`;

test("a capture's markup under the limit is kept as it is", () => {
  const html = `<html><head>${style(1000)}</head><body><form>${question(1)}</form></body></html>`;
  assert.equal(boundSnapshotMarkup(html), html);
});

test("styles over the limit give way to the form in the body", () => {
  const html = `<html><head><title>Apply</title>${style(1_500_000)}${style(900_000)}${style(500)}</head><body><form>${question(1)}${question(2)}${question(3)}</form></body></html>`;
  const kept = boundSnapshotMarkup(html);
  assert.ok(kept.length <= SNAPSHOT_LIMIT);
  for (const n of [1, 2, 3]) assert.match(kept, new RegExp(`name="q${n}" value="No"`));
  // Only as many styles go as the limit needs: the small one stays.
  assert.ok(kept.includes(style(500)));
  assert.ok(kept.includes(style(900_000)));
  assert.match(kept, /<style>\/\* omitted 1500000 characters \*\/<\/style>/);
});

test("encoded images, icon paths and script bodies go before any style", () => {
  const icon = `<svg><path d="${"M1 1L2 2".repeat(40_000)}"></path></svg>`;
  const image = `<img src="data:image/png;base64,${"A".repeat(600_000)}">`;
  const script = `<template shadowrootmode="open"><script>${"x;".repeat(300_000)}</script><input name="inner"></template>`;
  const html = `<html><head>${style(1_000_000)}</head><body>${icon}${image}<form><my-date>${script}</my-date>${question(1)}</form></body></html>`;
  const kept = boundSnapshotMarkup(html);
  assert.ok(kept.length <= SNAPSHOT_LIMIT);
  assert.ok(kept.includes(style(1_000_000)));
  assert.match(kept, /<path d="M0 0">/);
  assert.match(kept, /src="data:,omitted 600022 characters"/);
  assert.match(kept, /<template shadowrootmode="open"><script>\/\* omitted 600000 characters \*\/<\/script><input name="inner">/);
});

test("a body still over the limit keeps the part around the form", () => {
  const filler = (size: number) => `<div>${"<p>news</p>".repeat(size / 11)}</div>`;
  const html = `<html><head><title>Apply</title><link rel="stylesheet" href="/a.css"></head><body>${filler(1_500_000)}<form>${question(1)}${question(2)}</form>${filler(1_500_000)}</body></html>`;
  const kept = boundSnapshotMarkup(html, 1_000_000);
  assert.ok(kept.length <= 1_000_000);
  assert.ok(kept.startsWith("<html><head><title>Apply</title>"));
  assert.match(kept, /<body>/);
  assert.match(kept, /name="q1" value="Yes"[\s\S]*name="q2" value="No"/);
  assert.match(kept, /lane: omitted \d+ characters before the form/);
  assert.match(kept, /lane: omitted \d+ characters after the form/);
});

test("a long head with no styles keeps its title and metas", () => {
  const html = `<html><head><meta charset="utf-8"><title>Apply</title>${'<link rel="preload" href="/x.js">'.repeat(80_000)}</head><body><form>${question(1)}</form></body></html>`;
  const kept = boundSnapshotMarkup(html);
  assert.ok(kept.length <= SNAPSHOT_LIMIT);
  assert.match(kept, /<head><meta charset="utf-8"><title>Apply<\/title><!-- lane: head omitted \d+ characters --><\/head>/);
  assert.match(kept, /name="q1" value="No"/);
});
