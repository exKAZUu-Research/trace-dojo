import SuperTokens from 'supertokens-node';
import EmailPasswordNode from 'supertokens-node/recipe/emailpassword';
import SessionNode from 'supertokens-node/recipe/session';
import type { TypeInput } from 'supertokens-node/types';

import { appInfo } from './appInfo';

export const backendConfig = (): TypeInput => {
  return {
    framework: 'custom',
    supertokens: {
      // https://try.supertokens.com is for demo purposes. Replace this with the address of your core instance (sign up on supertokens.com), or self host a core.
      connectionURI: 'https://try.supertokens.com',
      // apiKey: <API_KEY(if configured)>,
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
