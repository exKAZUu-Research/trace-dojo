/* eslint-disable unicorn/filename-case */
// TODO: Remove the above line after the ESLint config is fixed.
'use client';

import { useEffect } from 'react';

const GlobalError: React.FC<{ error: Error & { digest?: string }; reset: () => void }> = ({ error }) => {
  const errorText = `Error:
  - Name: ${error.name}
  - Digest: ${error.digest}
  - Message: ${error.message}
  - Stack: ----------- start -----------
${error.stack}
  ---------------- end -----------------`;

  useEffect(() => {
    console.error(error);
  }, [error]);

  const copyToClipboard: () => void = () => {
    void navigator.clipboard.writeText(errorText);
    alert('コピーしました');
  };

  return (
    <html>
      <body style={{ fontFamily: 'Arial, sans-serif', padding: '20px', backgroundColor: '#f8f8f8' }}>
        <div style={{ border: '1px solid #ccc', borderRadius: '8px', padding: '20px', backgroundColor: '#fff' }}>
          <p>
            予期せぬエラーが発生しました。問題が解決しない場合は、以下のエラー全文を坂本
            (sakamoto.kazunori@internet.ac.jp) にお知らせください。
          </p>
          <button
            style={{
              backgroundColor: '#3182ce',
              color: '#fff',
              padding: '10px 20px',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              marginBottom: '10px',
            }}
            onClick={() => { globalThis.location.reload(); }}
          >
            再試行
          </button>
          <div style={{ position: 'relative', backgroundColor: '#f0f0f0', padding: '10px', borderRadius: '4px' }}>
            <button
              style={{
                position: 'absolute',
                right: '10px',
                top: '10px',
                backgroundColor: '#e2e8f0',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                padding: '5px 10px',
                display: 'flex',
                alignItems: 'center',
              }}
              onClick={copyToClipboard}
            >
              コピー
            </button>
            <pre style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word', fontFamily: 'monospace' }}>{errorText}</pre>
          </div>
        </div>
      </body>
    </html>
  );
};

export default GlobalError;
