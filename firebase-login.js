// Loaded on demand by admin.js. Firebase is used ONLY to prove who is signing in:
// we get a Google-signed ID token, the Lamnian server verifies it and the admin
// email, then starts its own session. Nothing else is stored in Firebase.
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

export async function googleIdToken(firebaseConfig) {
  const app = getApps()[0] || initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(auth, provider);
  const token = await cred.user.getIdToken(true);
  await signOut(auth);
  return token;
}
