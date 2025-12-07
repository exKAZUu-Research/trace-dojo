module.exports = {
  apps: [
    {
      script: `node_modules/.bin/dotenv -c ${process.env.WB_ENV} -- node node_modules/.bin/next start`,
    },
  ],
};
