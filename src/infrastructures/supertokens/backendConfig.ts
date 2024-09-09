import SuperTokens from 'supertokens-node';
import DashboardNode from 'supertokens-node/recipe/dashboard';
import EmailPasswordNode from 'supertokens-node/recipe/emailpassword';
import SessionNode from 'supertokens-node/recipe/session';
import UserRolesNode from 'supertokens-node/recipe/userroles';
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
    recipeList: [
      DashboardNode.init(),
      EmailPasswordNode.init({
        override: {
          functions: (originalImplementation) => {
            return {
              ...originalImplementation,
              async signUp(input) {
                if (process.env.WB_ENV === 'production' && !input.email.toLowerCase().endsWith('@internet.ac.jp')) {
                  return {
                    status: 'LINKING_TO_SESSION_USER_FAILED',
                    reason: 'EMAIL_VERIFICATION_REQUIRED',
                  };
                }
                return await originalImplementation.signUp(input);
              },
            };
          },
        },
      }),
      SessionNode.init(),
      UserRolesNode.init(),
    ],
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
