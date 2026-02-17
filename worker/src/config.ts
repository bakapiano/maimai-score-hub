const env = process.env.NODE_ENV || "dev";

const config = {
  dev: env === "dev",
  port: parseInt(process.env.API_PORT || "3999", 10),
  fetchTimeOut: parseInt(process.env.FETCH_TIMEOUT || "300000", 10),
  fetchRetryCount: parseInt(process.env.FETCH_RETRY_COUNT || "5", 10),
  redirectUrl: process.env.REDIRECT_URL || "http://106.14.237.126:3999/",
  host: (process.env.HOST_WHITE_LIST || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  httpProxy: {
    port: parseInt(process.env.HTTP_PROXY_PORT || "2222", 10),
  },
  jobService: {
    baseUrl:
      process.env.JOB_SERVICE_BASE_URL ||
      "https://api.maiscorehub.bakapiano.com/",
  },
};

export default config;
