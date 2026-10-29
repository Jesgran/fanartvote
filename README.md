# Voto Fan Art

Pannello mobile-first per votare le fan art postate in un forum Discord.

- **Accesso**: un tap su "Entra con Discord" (OAuth2). Verifica che l'utente sia nel server (e, opzionale, abbia un ruolo). Un account = un voto per opera.
- **Opere automatiche**: un bot legge il canale forum ogni 10 min (o a mano da Admin → Sincronizza). Per ogni post prende titolo, descrizione e **tutte le immagini del primo messaggio** (mostrate come galleria a scorrimento). Le immagini sono scaricate, validate e ricodificate in WebP (le URL Discord scadono).
- **Voti**: 1–10, cambi o rimuovi quando vuoi finché le votazioni sono aperte. Tab *Da votare / Votati / Tutti*, barra di avanzamento.
- **Autori visibili**: il nome dell'artista è mostrato dopo il titolo anche durante le votazioni. Ordine delle opere diverso per ogni utente; non si può votare la propria opera.
- **Classifica**: solo admin durante il contest, pubblica alla chiusura.

## Setup
1. https://discord.com/developers/applications → New Application.
   - OAuth2 → Redirects: `BASE_URL/auth/callback`. Copia Client ID e Secret.
   - Bot → Reset Token. Invita il bot nel server (OAuth2 URL Generator: scope `bot`) con permessi *View Channel* e *Read Message History* sul forum.
2. `copy .env.example .env` e compila (ID server, ID canale forum, ID admin: Discord → Impostazioni sviluppatore → Modalità sviluppatore → tasto destro → Copia ID).
3. `npm install` poi `npm start`.
4. Per usarlo da telefono serve un URL **https** pubblico: Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`) o un host (Render, Fly, VPS). Metti quell'URL in `BASE_URL`, nel Redirect Discord e `TRUST_PROXY=1`.

## Sicurezza
Sessioni con token casuale (hash nel DB), cookie HttpOnly/Secure/SameSite, `state` OAuth, anti-CSRF (header custom + controllo Origin), CSP stretta senza inline, nessun `innerHTML` (testo utente sempre escapato), query parametrizzate, validazione voti server-side, rate limit globale e per utente, immagini ricodificate e servite solo ai loggati, nessun access token Discord salvato, log di ogni modifica voto (`vote_log`). I dati stanno in `data/` (SQLite + media): fanne il backup.
