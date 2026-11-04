import assert from "node:assert/strict";
import { test } from "node:test";
import { devToolsEnabled } from "../src/shared/dev-tools";

test("the development tools are on where the fixer's script is, unless LANE_DEV_TOOLS says otherwise", () => {
  assert.equal(devToolsEnabled({}, () => true), true);
  assert.equal(devToolsEnabled({}, () => false), false);
  assert.equal(devToolsEnabled({ LANE_DEV_TOOLS: "1" }, () => false), true);
  assert.equal(devToolsEnabled({ LANE_DEV_TOOLS: "0" }, () => true), false);
  assert.equal(devToolsEnabled({ LANE_DEV_TOOLS: "" }, () => true), true);
});
