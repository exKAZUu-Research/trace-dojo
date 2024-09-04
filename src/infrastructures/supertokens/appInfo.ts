export const appInfo = {
  // cf. https://supertokens.com/docs/emailpassword/nextjs/app-directory/init
  appName: 'TraceDojo',
  apiDomain: process.env.NEXT_PUBLIC_BASE_URL ?? '',
  websiteDomain: process.env.NEXT_PUBLIC_BASE_URL ?? '',
  apiBasePath: '/api/auth',
  websiteBasePath: '/auth',
};
