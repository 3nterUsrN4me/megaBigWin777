# web-client — MegaBigWin777 Blackjack

Minimalistyczny klient SPA do gry w Blackjacka, łączący się przez WebSocket z `gateway/ws`.

## Szybki start

```bash
# 1. Zainstaluj zależności
cd apps/web-client
npm install

# 2. Uruchom klienta (Vite dev server na :5173)
npm run dev
```

W osobnym terminalu uruchom serwer gateway:

```bash
cd gateway/ws
npm run dev
```

Następnie otwórz http://localhost:5173 w przeglądarce.

## Jak grać

1. Wpisz **Table ID** (dowolny string, np. `table-dev-001`), **Zakład** i **Player ID**.
2. Kliknij **JOIN ROOM** — aplikacja:
   - Generuje token JWT za pomocą dev-secret (wyłącznie do testów lokalnych!)
   - Łączy się przez WebSocket z `ws://localhost:3001/ws?token=<jwt>`
   - Wysyła `JOIN_GAME` — serwer odpowiada `JOIN_ACK`, `DEAL`, a potem `GAME_STATE`
3. Klikaj **HIT**, **STAND**, **DOUBLE DOWN** lub używaj skrótów klawiszowych: `H`, `S`, `D`.
4. Po zakończeniu rundy pojawia się banner z wynikiem i przycisk **Nowa Gra**.

## Zmienne środowiskowe (`.env`)

| Zmienna | Domyślna | Opis |
|---------|---------|------|
| `VITE_WS_URL` | `ws://localhost:3001/ws` | URL do serwera gateway |
| `VITE_JWT_SECRET` | `dev-secret-for-testing-CHANGE-IN-PROD!!` | Secret do generowania dev JWT |

## Struktura plików

```
apps/web-client/
├── index.html          # Układ HTML + Tailwind CSS (CDN)
├── src/
│   ├── types.ts        # Typy domenowe i protokołu WS
│   ├── wsClient.ts     # Menedżer WebSocket + heartbeat PING/PONG
│   ├── gameStore.ts    # Reaktywny store stanu gry
│   ├── renderer.ts     # Renderowanie kart i UI
│   └── main.ts         # Punkt wejścia, obsługa buttonów
├── vite.config.ts
├── tsconfig.json
└── .env
```

## Uwagi

- JWT jest generowany **po stronie klienta** tylko na potrzeby dev — w produkcji token pochodzi z `POST /auth/login`.
- Przeglądarka nie może ustawić nagłówka `Authorization` dla WebSocket, dlatego token jest przekazywany jako `?token=` query param. Serwer (`gateway/ws/src/auth/jwtVerify.ts`) obsługuje oba sposoby.
