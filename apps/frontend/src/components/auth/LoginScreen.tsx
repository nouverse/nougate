import { Shield } from 'lucide-react';
import { startLogin } from '@/hooks/useAuth';

/**
 * Google's brand mark, inlined so the login screen has no external dependency.
 */
function GoogleMark() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function LoginScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-base-100 font-sans p-6">
      <div className="w-full max-w-sm text-center">
        <div className="inline-flex items-center gap-3 mb-8">
          <div className="bg-primary text-primary-content p-2 rounded-xl">
            <Shield className="w-6 h-6" />
          </div>
          <div className="text-left">
            <span className="font-extrabold text-base-content text-xl tracking-wider block leading-none">
              NOUGATE
            </span>
            <span className="block text-[10px] text-base-content/40 font-mono tracking-widest mt-1">
              NOUVERSE AI GATEWAY
            </span>
          </div>
        </div>

        <div className="bg-base-200 border border-base-300 rounded-2xl p-8">
          <h1 className="text-sm font-bold text-base-content mb-2">Sign in to continue</h1>
          <p className="text-xs text-base-content/60 leading-relaxed mb-6">
            This dashboard is restricted to approved Google accounts.
          </p>

          <button
            onClick={startLogin}
            className="btn btn-primary btn-sm w-full gap-2 font-semibold"
          >
            <GoogleMark />
            Continue with Google
          </button>
        </div>

        <p className="text-[10px] text-base-content/40 font-mono mt-6">
          Just Admin can give the access
        </p>
      </div>
    </div>
  );
}
