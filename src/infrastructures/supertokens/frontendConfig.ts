import type { useRouter } from 'next/navigation';
import SuperTokensReact from 'supertokens-auth-react';
import type { SuperTokensConfig } from 'supertokens-auth-react/lib/build/types';
import EmailPasswordReact from 'supertokens-auth-react/recipe/emailpassword';
import EmailVerificationReact from 'supertokens-auth-react/recipe/emailverification';
import SessionReact from 'supertokens-auth-react/recipe/session';

import { appInfo } from './appInfo';

const routerInfo: { router?: ReturnType<typeof useRouter>; pathName?: string } = {};

export function setRouter(router: ReturnType<typeof useRouter>, pathName: string): void {
  routerInfo.router = router;
  routerInfo.pathName = pathName;
}

export const frontendConfig = (): SuperTokensConfig => {
  return {
    appInfo,
    recipeList: [
      EmailPasswordReact.init(),
      ...(process.env.NEXT_PUBLIC_WB_VERSION === 'staging' || process.env.NEXT_PUBLIC_WB_VERSION === 'production'
        ? [EmailVerificationReact.init({ mode: 'REQUIRED' })]
        : []),
      SessionReact.init(),
    ],
    windowHandler: (original) => ({
      ...original,
      location: {
        ...original.location,
        getPathName: () => routerInfo.pathName!,
        assign: (url) => routerInfo.router!.push(url.toString()),
        setHref: (url) => routerInfo.router!.push(url.toString()),
      },
    }),
    // https://supertokens.com/docs/thirdpartyemailpassword/common-customizations/translations
    languageTranslations: {
      translations: {
        ja: {
          // defaultTranslationsCommon
          // https://github.com/supertokens/supertokens-auth-react/blob/master/lib/ts/translation/translations.ts
          AUTH_PAGE_HEADER_TITLE_SIGN_IN_AND_UP: '新規登録 / ログイン',
          AUTH_PAGE_HEADER_TITLE_SIGN_IN: 'ログイン',
          AUTH_PAGE_HEADER_TITLE_SIGN_UP: '新規登録',

          AUTH_PAGE_HEADER_SUBTITLE_SIGN_IN_START: 'まだアカウントをお持ちでない方は',
          AUTH_PAGE_HEADER_SUBTITLE_SIGN_IN_SIGN_UP_LINK: '新規登録',
          AUTH_PAGE_HEADER_SUBTITLE_SIGN_IN_END: 'へ',

          AUTH_PAGE_HEADER_SUBTITLE_SIGN_UP_START: 'すでにアカウントをお持ちの方は',
          AUTH_PAGE_HEADER_SUBTITLE_SIGN_UP_SIGN_IN_LINK: 'ログイン',
          AUTH_PAGE_HEADER_SUBTITLE_SIGN_UP_END: 'へ',

          AUTH_PAGE_FOOTER_START: '続行することで、',
          AUTH_PAGE_FOOTER_TOS: '利用規約',
          AUTH_PAGE_FOOTER_AND: 'および',
          AUTH_PAGE_FOOTER_PP: 'プライバシーポリシー',
          AUTH_PAGE_FOOTER_END: 'に同意したものとみなされます。',

          DIVIDER_OR: 'または',

          BRANDING_POWERED_BY_START: 'Powered by ',
          BRANDING_POWERED_BY_END: '',
          SOMETHING_WENT_WRONG_ERROR: '問題が発生しました。もう一度お試しください。',
          SOMETHING_WENT_WRONG_ERROR_RELOAD: '問題が発生しました。後ほど再試行するか、ページを再読み込みしてください。',

          // defaultTranslationsEmailVerification
          // https://github.com/supertokens/supertokens-auth-react/blob/master/lib/ts/recipe/emailverification/components/themes/translations.ts
          EMAIL_VERIFICATION_RESEND_SUCCESS: 'メールを再送信しました',
          EMAIL_VERIFICATION_SEND_TITLE: 'メールアドレスを確認してください！',
          EMAIL_VERIFICATION_SEND_DESC_START: '',
          EMAIL_VERIFICATION_SEND_DESC_STRONG: 'リンクをクリックして',
          EMAIL_VERIFICATION_SEND_DESC_END: 'メールアドレスを確認してください。確認用メールを送信しました。',
          EMAIL_VERIFICATION_RESEND_BTN: 'メールを再送信',
          EMAIL_VERIFICATION_LOGOUT: 'ログアウト ',
          EMAIL_VERIFICATION_SUCCESS: 'メールアドレスの確認が完了しました！',
          EMAIL_VERIFICATION_CONTINUE_BTN: '続ける',
          EMAIL_VERIFICATION_CONTINUE_LINK: '続ける',
          EMAIL_VERIFICATION_EXPIRED: 'メール確認リンクの有効期限が切れました',
          EMAIL_VERIFICATION_ERROR_TITLE: '問題が発生しました',
          EMAIL_VERIFICATION_ERROR_DESC: '予期せぬエラーが発生しました。サポートにお問い合わせください。',
          EMAIL_VERIFICATION_LINK_CLICKED_HEADER: 'メールアドレスを確認',
          EMAIL_VERIFICATION_LINK_CLICKED_DESC: '下のボタンをクリックしてメールアドレスを確認してください',
          EMAIL_VERIFICATION_LINK_CLICKED_CONTINUE_BUTTON: '続ける',

          // defaultTranslationsEmailPassword
          // https://github.com/supertokens/supertokens-auth-react/blob/master/lib/ts/recipe/emailpassword/components/themes/translations.ts
          EMAIL_PASSWORD_EMAIL_LABEL: 'メールアドレス',
          EMAIL_PASSWORD_EMAIL_PLACEHOLDER: 'メールアドレス',

          EMAIL_PASSWORD_PASSWORD_LABEL: 'パスワード',
          EMAIL_PASSWORD_PASSWORD_PLACEHOLDER: 'パスワード',

          EMAIL_PASSWORD_SIGN_IN_FORGOT_PW_LINK: 'パスワードをお忘れですか？',
          EMAIL_PASSWORD_SIGN_IN_SUBMIT_BTN: 'ログイン',
          EMAIL_PASSWORD_SIGN_IN_WRONG_CREDENTIALS_ERROR: 'メールアドレスまたはパスワードが正しくありません',

          EMAIL_PASSWORD_SIGN_UP_SUBMIT_BTN: '新規登録',

          EMAIL_PASSWORD_EMAIL_ALREADY_EXISTS: 'このメールアドレスは既に登録されています。ログインしてください。',

          EMAIL_PASSWORD_RESET_HEADER_TITLE: 'パスワードをリセット',
          EMAIL_PASSWORD_RESET_HEADER_SUBTITLE: 'パスワードをリセットするためのメールを送信します',
          EMAIL_PASSWORD_RESET_SEND_FALLBACK_EMAIL: 'あなたのアカウント',
          EMAIL_PASSWORD_RESET_SEND_BEFORE_EMAIL: 'パスワードリセットメールを ',
          EMAIL_PASSWORD_RESET_SEND_AFTER_EMAIL: ' に送信しました（システムに登録されている場合）。',
          EMAIL_PASSWORD_RESET_RESEND_LINK: '再送信またはメールアドレスの変更',
          EMAIL_PASSWORD_RESET_SEND_BTN: 'メールを送信',
          EMAIL_PASSWORD_RESET_SIGN_IN_LINK: 'ログイン',

          EMAIL_PASSWORD_RESET_SUBMIT_PW_SUCCESS_HEADER_TITLE: '成功！',
          EMAIL_PASSWORD_RESET_SUBMIT_PW_SUCCESS_DESC: 'パスワードが正常に更新されました',
          EMAIL_PASSWORD_RESET_SUBMIT_PW_SUCCESS_SIGN_IN_BTN: 'ログイン',

          EMAIL_PASSWORD_NEW_PASSWORD_LABEL: '新しいパスワード',
          EMAIL_PASSWORD_NEW_PASSWORD_PLACEHOLDER: '新しいパスワード',
          EMAIL_PASSWORD_CONFIRM_PASSWORD_LABEL: 'パスワードの確認',
          EMAIL_PASSWORD_CONFIRM_PASSWORD_PLACEHOLDER: 'パスワードを確認',

          EMAIL_PASSWORD_RESET_SUBMIT_PW_HEADER_TITLE: 'パスワードを変更',
          EMAIL_PASSWORD_RESET_SUBMIT_PW_HEADER_SUBTITLE: '新しいパスワードを入力してください',
          EMAIL_PASSWORD_RESET_SUBMIT_PW_CHANGE_PW_BTN: 'パスワードを変更',
          EMAIL_PASSWORD_RESET_PASSWORD_INVALID_TOKEN_ERROR: '無効なパスワードリセットトークンです',

          ERROR_EMAIL_NON_STRING: 'メールアドレスは文字列である必要があります',
          ERROR_EMAIL_INVALID: 'メールアドレスが無効です',

          ERROR_PASSWORD_NON_STRING: 'パスワードは文字列である必要があります',
          ERROR_PASSWORD_TOO_SHORT: 'パスワードは8文字以上で、数字を含む必要があります',
          ERROR_PASSWORD_TOO_LONG: 'パスワードは100文字未満である必要があります',
          ERROR_PASSWORD_NO_ALPHA: 'パスワードはアルファベットを少なくとも1文字含む必要があります',
          ERROR_PASSWORD_NO_NUM: 'パスワードは数字を少なくとも1文字含む必要があります',
          ERROR_CONFIRM_PASSWORD_NO_MATCH: '確認用パスワードが一致しません',

          ERROR_NON_OPTIONAL: 'このフィールドは必須です',
        },
      },
    },
  };
};

let isInitialized = false;

export function ensureSuperTokensReactInit(): void {
  if (typeof window === 'undefined') return;
  if (isInitialized) return;
  SuperTokensReact.init(frontendConfig());
  isInitialized = true;
}
