const fs = require("node:fs");
const path = require("node:path");

const { generateOpenApi } = require("@ts-rest/open-api");
const { stringify } = require("yaml");

const { openApiContract } = require("../dist/openapi.contract.js");

const openApiDoc = generateOpenApi(
  openApiContract,
  {
    info: {
      title: "Maimai Score Hub API",
      version: "1.0.0",
      description: "Generated from @maimai-score-hub/shared ts-rest contracts",
    },
    servers: [{ url: "/api/v1" }],
  },
  {
    setOperationId: "concatenated-path",
  },
);

const outputPath = path.resolve(__dirname, "../openapi/openapi.yaml");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, stringify(openApiDoc), "utf8");

console.log(`OpenAPI YAML generated: ${outputPath}`);
