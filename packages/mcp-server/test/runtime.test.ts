import { describe, expect, it } from "vitest";

import { unsupportedNodeMessage } from "../src/runtime.js";

describe("unsupportedNodeMessage", () => {
  it("accepts Node.js 20 and later", () => {
    expect(unsupportedNodeMessage("20.0.0")).toBeNull();
    expect(unsupportedNodeMessage("24.15.0")).toBeNull();
  });

  it("explains what to install on an older Node.js", () => {
    const message = unsupportedNodeMessage("18.20.4");
    expect(message).toContain("Node.js 20 or later");
    expect(message).toContain("18.20.4");
  });
});
