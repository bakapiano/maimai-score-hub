import assert from "node:assert/strict";
import test from "node:test";

import { copyTextToClipboard } from "../src/utils/clipboard.ts";

test("copyTextToClipboard uses navigator.clipboard.writeText when available", async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  let copiedValue: string | null = null;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text: string) => {
          copiedValue = text;
        },
      },
    },
  });

  try {
    const result = await copyTextToClipboard("123456789012345");
    assert.equal(result, true);
    assert.equal(copiedValue, "123456789012345");
  } finally {
    if (previousNavigator) {
      Object.defineProperty(globalThis, "navigator", previousNavigator);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  }
});

test("copyTextToClipboard returns false gracefully when clipboard rejects without document", async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async () => {
          throw new Error("Permission denied");
        },
      },
    },
  });

  try {
    const result = await copyTextToClipboard("hello");
    assert.equal(result, false);
  } finally {
    if (previousNavigator) {
      Object.defineProperty(globalThis, "navigator", previousNavigator);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  }
});
