import { createConnection } from "node:net";

import {
  configuredValue,
  type E2eConfig,
  type E2eInfraMode,
} from "./config.ts";

export interface MongoEndpoint {
  host: string;
  port: number;
  database: string;
  user?: string;
  password?: string;
  authSource: string;
  url: string;
}

export interface RedisEndpoint {
  host: string;
  port: number;
  db: number;
  password?: string;
  url: string;
}

export interface TestInfrastructure {
  mode: E2eInfraMode;
  mongo: MongoEndpoint;
  redis: RedisEndpoint;
  stop(): Promise<void>;
}

export async function startInfrastructure(
  config: E2eConfig,
  runToken: string,
): Promise<TestInfrastructure> {
  if (config.infraMode === "containers") {
    return startContainers(runToken);
  }
  return useLocalServices(config, runToken);
}

async function useLocalServices(
  config: E2eConfig,
  runToken: string,
): Promise<TestInfrastructure> {
  const mongoHost =
    configuredValue(config.localEnv, "E2E_MONGO_HOST", "MONGO_HOST") ||
    "127.0.0.1";
  const mongoPort = numberValue(
    configuredValue(config.localEnv, "E2E_MONGO_PORT", "MONGO_PORT"),
    27017,
  );
  const mongoUser = configuredValue(
    config.localEnv,
    "E2E_MONGO_USER",
    "MONGO_USER",
  );
  const mongoPassword = configuredValue(
    config.localEnv,
    "E2E_MONGO_PASSWORD",
    "MONGO_PASSWORD",
  );
  const mongoAuthSource =
    configuredValue(
      config.localEnv,
      "E2E_MONGO_AUTH_SOURCE",
      "MONGO_AUTH_SOURCE",
    ) || "admin";
  const mongoDatabase = `${databasePrefix(
    configuredValue(config.localEnv, "E2E_MONGO_DB_PREFIX"),
  )}${runToken}`;

  const redisHost =
    configuredValue(config.localEnv, "E2E_REDIS_HOST", "REDIS_HOST") ||
    "127.0.0.1";
  const redisPort = numberValue(
    configuredValue(config.localEnv, "E2E_REDIS_PORT", "REDIS_PORT"),
    6379,
  );
  const redisDb = numberValue(
    configuredValue(config.localEnv, "E2E_REDIS_DB", "REDIS_DB"),
    0,
  );
  const redisPassword = configuredValue(
    config.localEnv,
    "E2E_REDIS_PASSWORD",
    "REDIS_PASSWORD",
  );

  await Promise.all([
    assertTcpReachable("MongoDB", mongoHost, mongoPort),
    assertTcpReachable("Redis", redisHost, redisPort),
  ]);

  return {
    mode: "local",
    mongo: mongoEndpoint({
      host: mongoHost,
      port: mongoPort,
      database: mongoDatabase,
      user: mongoUser,
      password: mongoPassword,
      authSource: mongoAuthSource,
    }),
    redis: redisEndpoint({
      host: redisHost,
      port: redisPort,
      db: redisDb,
      password: redisPassword,
    }),
    stop: async () => undefined,
  };
}

async function startContainers(runToken: string): Promise<TestInfrastructure> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const [mongoResult, redisResult] = await Promise.allSettled([
    new GenericContainer(process.env.E2E_MONGO_IMAGE || "mongo:7")
      .withExposedPorts(27017)
      .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/i))
      .start(),
    new GenericContainer(process.env.E2E_REDIS_IMAGE || "redis:7-alpine")
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/i))
      .start(),
  ]);
  if (mongoResult.status === "rejected" || redisResult.status === "rejected") {
    await Promise.allSettled([
      ...(mongoResult.status === "fulfilled"
        ? [mongoResult.value.stop()]
        : []),
      ...(redisResult.status === "fulfilled"
        ? [redisResult.value.stop()]
        : []),
    ]);
    throw new AggregateError(
      [mongoResult, redisResult]
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason),
      "Unable to start E2E infrastructure containers",
    );
  }

  const mongo = mongoResult.value;
  const redis = redisResult.value;
  return {
    mode: "containers",
    mongo: mongoEndpoint({
      host: mongo.getHost(),
      port: mongo.getMappedPort(27017),
      database: `msh_e2e_${runToken}`,
      authSource: "admin",
    }),
    redis: redisEndpoint({
      host: redis.getHost(),
      port: redis.getMappedPort(6379),
      db: 0,
    }),
    stop: async () => {
      await Promise.allSettled([mongo.stop(), redis.stop()]);
    },
  };
}

function mongoEndpoint(input: {
  host: string;
  port: number;
  database: string;
  user?: string;
  password?: string;
  authSource: string;
}): MongoEndpoint {
  const credentials =
    input.user && input.password
      ? `${encodeURIComponent(input.user)}:${encodeURIComponent(input.password)}@`
      : "";
  const authQuery =
    input.user && input.password
      ? `?authSource=${encodeURIComponent(input.authSource)}`
      : "";
  return {
    ...input,
    url: `mongodb://${credentials}${input.host}:${input.port}/${input.database}${authQuery}`,
  };
}

function redisEndpoint(input: {
  host: string;
  port: number;
  db: number;
  password?: string;
}): RedisEndpoint {
  const credentials = input.password
    ? `:${encodeURIComponent(input.password)}@`
    : "";
  return {
    ...input,
    url: `redis://${credentials}${input.host}:${input.port}/${input.db}`,
  };
}

function numberValue(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function databasePrefix(raw: string | undefined): string {
  const prefix = (raw || "msh_e2e_").replace(/[^A-Za-z0-9_-]/g, "_");
  if (!prefix) {
    throw new Error("E2E_MONGO_DB_PREFIX must contain a safe database prefix");
  }
  return prefix;
}

function assertTcpReachable(
  label: string,
  host: string,
  port: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `${label} is not reachable at ${host}:${port}. Start the local service or use npm run test:containers.`,
        ),
      );
    }, 2_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      socket.destroy();
      reject(
        new Error(
          `${label} is not reachable at ${host}:${port}: ${error.message}`,
        ),
      );
    });
  });
}
