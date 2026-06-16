/**
 * game-core — czysta, deterministyczna logika Blackjacka.
 *
 * Zasady:
 *  - Zero side-effects, zero importów sieciowych/bazodanowych.
 *  - Każda funkcja jest deterministyczna: ten sam input → ten sam output.
 *  - RNG wstrzykiwany przez parametr `seed` w createDeck.
 *  - Dealer gra według zasad Las Vegas: hits on soft 17.
 *  - Blackjack wypłaca 3:2.
 */

import seedrandom from "seedrandom";
import type {
  Card,
  Suit,
  Rank,
  GameResult,
  DomainError,
  Result,
} from "../../../contracts/domain.js";

// Re-eksport typów kontraktu dla konsumentów tego modułu
export type { Card, Suit, Rank, GameResult, DomainError, Result };

// ─── Stałe talii ──────────────────────────────────────────────────────────────

const SUITS: Suit[] = ["HEARTS", "DIAMONDS", "CLUBS", "SPADES"];
const RANKS: Rank[] = [
  "2", "3", "4", "5", "6", "7", "8", "9", "10",
  "J", "Q", "K", "A",
];

// ─── createDeck ───────────────────────────────────────────────────────────────

/**
 * Tworzy potasowaną talię 52 kart z deterministycznym seedem RNG.
 * Ten sam `seed` zawsze produkuje identyczną kolejność kart.
 */
export function createDeck(seed: string): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }

  const rng = seedrandom(seed);

  // Algorytm Fisher-Yates (Knuth shuffle)
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }

  return deck;
}

// ─── calculateHandValue ───────────────────────────────────────────────────────

/**
 * Oblicza wartość ręki uwzględniając:
 *  - Karty ukryte (hidden: true) są pomijane.
 *  - As = 11, redukowany do 1 gdy suma > 21 (może być kilka Asów).
 *  - isSoft = true gdy przynajmniej jeden As jest liczony jako 11.
 *  - isBlackjack = dokładnie 2 karty o wartości 21 (isSoft wymuszony na false).
 */
export function calculateHandValue(cards: Card[]): {
  value: number;
  isSoft: boolean;
  isBust: boolean;
  isBlackjack: boolean;
} {
  const visible = cards.filter((c) => !c.hidden);

  let value = 0;
  let aceCount = 0;

  for (const card of visible) {
    if (card.rank === "A") {
      aceCount++;
      value += 11;
    } else if (card.rank === "J" || card.rank === "Q" || card.rank === "K") {
      value += 10;
    } else {
      value += parseInt(card.rank, 10);
    }
  }

  // Redukuj Asy z 11 do 1 dopóki value > 21
  let softAces = aceCount;
  while (value > 21 && softAces > 0) {
    value -= 10;
    softAces--;
  }

  const isBlackjack = cards.length === 2 && value === 21;
  // Gdy Blackjack, isSoft = false (natural 21 nie jest grany strategicznie jako soft)
  const isSoft = softAces > 0 && !isBlackjack;
  const isBust = value > 21;

  return { value, isSoft, isBust, isBlackjack };
}

// ─── dealInitialCards ─────────────────────────────────────────────────────────

/**
 * Rozdaje początkowe karty w kolejności standardowej dla Blackjacka:
 *   gracz[0], dealer[0], gracz[1], dealer[1 — ukryta]
 */
export function dealInitialCards(deck: Card[]): {
  playerHand: Card[];
  dealerHand: Card[];
  remainingDeck: Card[];
} {
  const remaining = [...deck];

  const playerCard1 = remaining.shift()!;
  const dealerCard1 = remaining.shift()!;
  const playerCard2 = remaining.shift()!;
  const dealerCard2Hidden: Card = { ...remaining.shift()!, hidden: true };

  return {
    playerHand: [playerCard1, playerCard2],
    dealerHand: [dealerCard1, dealerCard2Hidden],
    remainingDeck: remaining,
  };
}

// ─── applyHit ─────────────────────────────────────────────────────────────────

/**
 * Gracz dobiera jedną kartę.
 * Zwraca ok:true z nową ręką (nawet przy bust — to game-service decyduje o stanie gry).
 * Zwraca ok:false gdy talia jest pusta.
 */
export function applyHit(
  deck: Card[],
  playerHand: Card[]
): Result<{ newCard: Card; playerHand: Card[]; remainingDeck: Card[] }> {
  if (deck.length === 0) {
    return {
      ok: false,
      error: { code: "INVALID_ACTION", message: "Deck is empty" },
    };
  }

  const remainingDeck = [...deck];
  const newCard = remainingDeck.shift()!;
  const newPlayerHand = [...playerHand, newCard];

  return {
    ok: true,
    value: { newCard, playerHand: newPlayerHand, remainingDeck },
  };
}

// ─── applyStand ───────────────────────────────────────────────────────────────

/**
 * Gracz staje — uruchamia logikę dealera.
 * Dealer:
 *  - Odkrywa ukrytą kartę.
 *  - Dobiera karty aż wartość >= 17 (hard) LUB >= 18 (soft 17 — musi dociągnąć).
 *  - Zasada Las Vegas: dealer hits on soft 17.
 */
export function applyStand(
  deck: Card[],
  dealerHand: Card[]
): Result<{ dealerHand: Card[]; remainingDeck: Card[] }> {
  const remainingDeck = [...deck];

  // Odkryj wszystkie ukryte karty
  let currentHand: Card[] = dealerHand.map((c) => ({ ...c, hidden: false }));

  while (true) {
    const { value, isSoft } = calculateHandValue(currentHand);

    // Dealer dobiera gdy: value < 17, LUB value == 17 i soft (hits soft 17)
    const mustHit = value < 17 || (value === 17 && isSoft);

    if (!mustHit) break;

    if (remainingDeck.length === 0) {
      return {
        ok: false,
        error: {
          code: "INVALID_ACTION",
          message: "Deck is empty during dealer turn",
        },
      };
    }

    currentHand = [...currentHand, remainingDeck.shift()!];
  }

  return { ok: true, value: { dealerHand: currentHand, remainingDeck } };
}

// ─── applyDoubleDown ──────────────────────────────────────────────────────────

/**
 * Gracz podwaja zakład — dobiera dokładnie jedną kartę i kończy turę.
 * Dozwolone tylko przy początkowej ręce (2 karty).
 */
export function applyDoubleDown(
  deck: Card[],
  playerHand: Card[]
): Result<{ newCard: Card; playerHand: Card[]; remainingDeck: Card[] }> {
  if (playerHand.length !== 2) {
    return {
      ok: false,
      error: {
        code: "INVALID_ACTION",
        message: "Double down is only allowed on the initial two-card hand",
      },
    };
  }

  if (deck.length === 0) {
    return {
      ok: false,
      error: { code: "INVALID_ACTION", message: "Deck is empty" },
    };
  }

  const remainingDeck = [...deck];
  const newCard = remainingDeck.shift()!;
  const newPlayerHand = [...playerHand, newCard];

  return {
    ok: true,
    value: { newCard, playerHand: newPlayerHand, remainingDeck },
  };
}

// ─── determineResult ──────────────────────────────────────────────────────────

/**
 * Wyznacza wynik rundy po zakończeniu tur obu stron.
 * Przed wywołaniem wszystkie karty dealera powinny być odkryte.
 *
 * Pierwszeństwo:
 *  1. Bust gracza → LOSS
 *  2. Blackjack gracza (bez Blackjacka dealera) → BLACKJACK (3:2)
 *  3. Oboje Blackjack → PUSH
 *  4. Bust dealera → WIN
 *  5. Porównanie wartości
 */
export function determineResult(
  playerCards: Card[],
  dealerCards: Card[]
): GameResult {
  const player = calculateHandValue(
    playerCards.map((c) => ({ ...c, hidden: false }))
  );
  const dealer = calculateHandValue(
    dealerCards.map((c) => ({ ...c, hidden: false }))
  );

  if (player.isBust) return "LOSS";

  if (player.isBlackjack) {
    return dealer.isBlackjack ? "PUSH" : "BLACKJACK";
  }

  if (dealer.isBust) return "WIN";

  if (player.value > dealer.value) return "WIN";
  if (player.value < dealer.value) return "LOSS";
  return "PUSH";
}

// ─── calculateChipsDelta ──────────────────────────────────────────────────────

/**
 * Oblicza zmianę salda żetonów gracza po zakończeniu rundy.
 *  - WIN      → +betAmount
 *  - BLACKJACK → +floor(betAmount * 1.5)   (wypłata 3:2)
 *  - LOSS     → -betAmount
 *  - PUSH     → 0 (zwrot zakładu bez zysku)
 *  - null     → 0 (gra nierozstrzygnięta)
 */
export function calculateChipsDelta(
  result: GameResult,
  betAmount: number
): number {
  switch (result) {
    case "WIN":
      return betAmount;
    case "BLACKJACK":
      return Math.floor(betAmount * 1.5);
    case "LOSS":
      return -betAmount;
    case "PUSH":
      return 0;
    case null:
      return 0;
  }
}
