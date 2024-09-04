import SuperTokens from 'supertokens-node';
import EmailPasswordNode from 'supertokens-node/recipe/emailpassword';
import SessionNode from 'supertokens-node/recipe/session';
import type { TypeInput } from 'supertokens-node/types';

import { appInfo } from './appInfo';

export const backendConfig = (): TypeInput => {
  return {
    framework: 'custom',
    supertokens: {
      connectionURI: process.env.SUPERTOKENS_URI ?? '',
      apiKey: process.env.SUPERTOKENS_API_KEY ?? '',
    },
    appInfo,
    recipeList: [EmailPasswordNode.init(), SessionNode.init()],
    isInServerlessEnv: true,
  };
};

let initialized = false;

/**
 * This function is used in your APIs to make sure SuperTokens is initialised
 */
export function ensureSuperTokensInit(): void {
  if (!initialized) {
    SuperTokens.init(backendConfig());
    initialized = true;
  }
}
