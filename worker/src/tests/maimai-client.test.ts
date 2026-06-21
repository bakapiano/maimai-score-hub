import { dirname, resolve } from "node:path";

import { extractContainerRedMessage } from "../common/maimai/infra/errors.ts";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

// 测试 extractContainerRedMessage 函数
const here = dirname(fileURLToPath(import.meta.url));
const testFile = resolve(
  here,
  "fixtures/cookie-expire-2025-12-31T14-39-42-498Z.html",
);

const html = await readFile(testFile, "utf-8");
console.log("Testing extractContainerRedMessage with:", testFile);

const result = extractContainerRedMessage(html);
console.log("Extracted message:");
console.log(result);
