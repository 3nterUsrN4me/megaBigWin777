import { describe, it, expect } from "vitest";
import type { Card } from "../../../../contracts/domain.js";
import {
  calculateHandValue,
  createDeck,
  dealInitialCards,
  applyHit,
  applyStand,
  applyDoubleDown,
  determineResult,
  calculateChipsDelta,
} from "../index.js";

// ─── Pomocnicze factory ────────────────────────────────────────────────────────

const c = (rank: Card["rank"], suit: Card["suit"] = "HEARTS"): Card => ({
  suit,
  rank,
});

// ─── calculateHandValue ────────────────────────────────────────────────────────

describe("calculateHandValue", () => {
  it("liczy wartość prostą bez Asów (7 + 9 = 16)", () => {
    expect(calculateHandValue([c("7"), c("9", "DIAMONDS")])).toEqual({
      value: 16,
      isSoft: false,
      isBust: false,
      isBlackjack: false,
    });
  });

  it("liczy As jako 11, gdy suma ≤ 21 (A + 6 = 17, soft)", () => {
    expect(calculateHandValue([c("A"), c("6")])).toEqual({
      value: 17,
      isSoft: true,
      isBust: false,
      isBlackjack: false,
    });
  });

  it("redukuje Asa do 1, gdy suma > 21 (A + 6 + 9 = 16, hard)", () => {
    expect(calculateHandValue([c("A"), c("6"), c("9")])).toEqual({
      value: 16,
      isSoft: false,
      isBust: false,
      isBlackjack: false,
    });
  });

  it("wykrywa Blackjack — A + figura = 21, isSoft wymuszone na false", () => {
    expect(calculateHandValue([c("A"), c("K")])).toEqual({
      value: 21,
      isSoft: false,
      isBust: false,
      isBlackjack: true,
    });
  });

  it("wykrywa Blackjack — A + 10 = 21", () => {
    expect(calculateHandValue([c("A"), c("10")])).toEqual({
      value: 21,
      isSoft: false,
      isBust: false,
      isBlackjack: true,
    });
  });

  it("wykrywa bust — K + Q + 5 = 25", () => {
    expect(calculateHandValue([c("K"), c("Q"), c("5")])).toEqual({
      value: 25,
      isSoft: false,
      isBust: true,
      isBlackjack: false,
    });
  });

  it("dwa Asy: A + A = 12 (jeden jako 11, drugi jako 1), isSoft=true", () => {
    expect(calculateHandValue([c("A"), c("A", "CLUBS")])).toEqual({
      value: 12,
      isSoft: true,
      isBust: false,
      isBlackjack: false,
    });
  });

  it("dwa Asy + 9: A + A + 9 = 21 (11 + 1 + 9), isSoft=true, NIE Blackjack", () => {
    expect(calculateHandValue([c("A"), c("A", "CLUBS"), c("9")])).toEqual({
      value: 21,
      isSoft: true,
      isBust: false,
      isBlackjack: false,
    });
  });

  it("cztery Asy: A+A+A+A = 14 (11+1+1+1), isSoft=true", () => {
    const result = calculateHandValue([
      c("A"),
      c("A", "CLUBS"),
      c("A", "DIAMONDS"),
      c("A", "SPADES"),
    ]);
    expect(result).toEqual({
      value: 14,
      isSoft: true,
      isBust: false,
      isBlackjack: false,
    });
  });

  it("trzy Asy + 8: A+A+A+8 = 21 (11+1+1+8), isSoft=true", () => {
    const result = calculateHandValue([
      c("A"),
      c("A", "CLUBS"),
      c("A", "DIAMONDS"),
      c("8"),
    ]);
    expect(result).toEqual({
      value: 21,
      isSoft: true,
      isBust: false,
      isBlackjack: false,
    });
  });

  it("21 przy 3 kartach NIE jest Blackjackiem", () => {
    const result = calculateHandValue([c("7"), c("7", "CLUBS"), c("7", "DIAMONDS")]);
    expect(result.value).toBe(21);
    expect(result.isBlackjack).toBe(false);
  });

  it("karty ukryte (hidden: true) są pomijane przy obliczaniu wartości", () => {
    const hand: Card[] = [
      c("7"),
      { suit: "SPADES", rank: "K", hidden: true },
    ];
    expect(calculateHandValue(hand)).toEqual({
      value: 7,
      isSoft: false,
      isBust: false,
      isBlackjack: false,
    });
  });

  it("soft 18: A + 7 = 18 (soft)", () => {
    expect(calculateHandValue([c("A"), c("7")])).toMatchObject({
      value: 18,
      isSoft: true,
      isBust: false,
    });
  });

  it("K + A + A: oba Asy redukowane (10+11+11→32→22→12), isSoft=false", () => {
    // K=10, oba Asy startują jako 11 → 32; redukujemy do 22, potem do 12.
    // Żaden As nie zostaje jako 11 → isSoft=false.
    const result = calculateHandValue([c("K"), c("A"), c("A", "CLUBS")]);
    expect(result).toEqual({
      value: 12,
      isSoft: false,
      isBust: false,
      isBlackjack: false,
    });
  });
});

// ─── createDeck ───────────────────────────────────────────────────────────────

describe("createDeck (deterministyczny RNG)", () => {
  it("zwraca dokładnie 52 karty", () => {
    expect(createDeck("seed-52")).toHaveLength(52);
  });

  it("ten sam seed → identyczna kolejność kart", () => {
    const deck1 = createDeck("reproducible-seed");
    const deck2 = createDeck("reproducible-seed");
    expect(deck1).toEqual(deck2);
  });

  it("różne seedy → różna kolejność kart", () => {
    const deck1 = createDeck("seed-A");
    const deck2 = createDeck("seed-B");
    expect(deck1).not.toEqual(deck2);
  });

  it("każda karta jest unikalna (52 unikalnych kombinacji suit+rank)", () => {
    const deck = createDeck("unique-test");
    const keys = deck.map((card) => `${card.suit}-${card.rank}`);
    expect(new Set(keys).size).toBe(52);
  });

  it("talia zawiera 4 kolory × 13 wartości", () => {
    const deck = createDeck("structure-test");
    const suits = new Set(deck.map((c) => c.suit));
    const ranks = new Set(deck.map((c) => c.rank));
    expect(suits.size).toBe(4);
    expect(ranks.size).toBe(13);
  });
});

// ─── dealInitialCards ─────────────────────────────────────────────────────────

describe("dealInitialCards", () => {
  it("gracz dostaje 2 widoczne karty, dealer 2 karty (druga ukryta)", () => {
    const deck = createDeck("deal-test");
    const { playerHand, dealerHand, remainingDeck } = dealInitialCards(deck);

    expect(playerHand).toHaveLength(2);
    expect(dealerHand).toHaveLength(2);
    expect(playerHand[0]!.hidden).toBeFalsy();
    expect(playerHand[1]!.hidden).toBeFalsy();
    expect(dealerHand[0]!.hidden).toBeFalsy();
    expect(dealerHand[1]!.hidden).toBe(true);
  });

  it("po rozdaniu w talii zostają 48 kart", () => {
    const deck = createDeck("deal-count-test");
    const { remainingDeck } = dealInitialCards(deck);
    expect(remainingDeck).toHaveLength(48);
  });

  it("rozdane karty nie powtarzają się w talii", () => {
    const deck = createDeck("deal-unique");
    const { playerHand, dealerHand, remainingDeck } = dealInitialCards(deck);
    const dealtKeys = [...playerHand, ...dealerHand].map(
      (c) => `${c.suit}-${c.rank}`
    );
    const remainingKeys = remainingDeck.map((c) => `${c.suit}-${c.rank}`);
    dealtKeys.forEach((key) => expect(remainingKeys).not.toContain(key));
  });
});

// ─── applyHit ─────────────────────────────────────────────────────────────────

describe("applyHit", () => {
  it("dodaje jedną kartę do ręki gracza i zmniejsza talię o 1", () => {
    const deck: Card[] = [c("5"), c("K"), c("3")];
    const hand: Card[] = [c("7"), c("6")];
    const result = applyHit(deck, hand);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.playerHand).toHaveLength(3);
      expect(result.value.newCard).toEqual(c("5"));
      expect(result.value.remainingDeck).toHaveLength(2);
    }
  });

  it("zwraca ok:false gdy talia jest pusta", () => {
    const result = applyHit([], [c("7"), c("6")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_ACTION");
    }
  });

  it("zwraca ok:true nawet przy buście (game-service decyduje o stanie gry)", () => {
    const deck: Card[] = [c("9")];
    const hand: Card[] = [c("K"), c("Q")]; // 20 + 9 = 29 (bust)
    const result = applyHit(deck, hand);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { value, isBust } = calculateHandValue(result.value.playerHand);
      expect(value).toBe(29);
      expect(isBust).toBe(true);
    }
  });
});

// ─── applyStand (logika dealera) ──────────────────────────────────────────────

describe("applyStand (logika dealera)", () => {
  it("dealer dobiera karty, aż wartość >= 17 (hard 15 → dobiera 5 → 20)", () => {
    const fixedDeck: Card[] = [c("5"), c("K")];
    const dealerStartHand: Card[] = [c("6", "SPADES"), c("9", "DIAMONDS")]; // 15
    const result = applyStand(fixedDeck, dealerStartHand);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const { value } = calculateHandValue(result.value.dealerHand);
      expect(value).toBeGreaterThanOrEqual(17);
      expect(value).toBe(20);
    }
  });

  it("dealer zatrzymuje się przy twardym 17 (nie dobiera)", () => {
    const deck: Card[] = [c("2")];
    const dealerHand: Card[] = [c("K"), c("7")]; // hard 17
    const result = applyStand(deck, dealerHand);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dealerHand).toHaveLength(2);
      expect(result.value.remainingDeck).toHaveLength(1); // karta nie użyta
    }
  });

  it("dealer MUSI dobierać na soft 17 (A+6 = 17 soft, Las Vegas rule)", () => {
    const fixedDeck: Card[] = [c("3")];
    const dealerStartHand: Card[] = [c("A"), c("6")]; // soft 17
    const result = applyStand(fixedDeck, dealerStartHand);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dealerHand).toHaveLength(3);
      const { value } = calculateHandValue(result.value.dealerHand);
      expect(value).toBe(20); // A+6+3 = 20
    }
  });

  it("dealer MUSI dobierać na soft 16 (A+5 = 16 soft)", () => {
    const fixedDeck: Card[] = [c("3")];
    const dealerStartHand: Card[] = [c("A"), c("5")]; // soft 16
    const result = applyStand(fixedDeck, dealerStartHand);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dealerHand).toHaveLength(3);
    }
  });

  it("dealer odkrywa ukrytą kartę przed dobieraniem", () => {
    const deck: Card[] = [c("2")];
    const dealerHand: Card[] = [
      c("K"),
      { suit: "CLUBS", rank: "8", hidden: true }, // razem 18 po odkryciu
    ];
    const result = applyStand(deck, dealerHand);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dealerHand.every((c) => !c.hidden)).toBe(true);
      expect(result.value.dealerHand).toHaveLength(2); // 18 ≥ 17, nie dobiera
    }
  });

  it("dealer może zbustować podczas dobierania", () => {
    const deck: Card[] = [c("K"), c("K")];
    const dealerHand: Card[] = [c("6"), c("7")]; // 13 → dobiera K → 23 (bust)
    const result = applyStand(deck, dealerHand);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const { isBust } = calculateHandValue(result.value.dealerHand);
      expect(isBust).toBe(true);
    }
  });
});

// ─── applyDoubleDown ──────────────────────────────────────────────────────────

describe("applyDoubleDown", () => {
  it("gracz z 2 kartami dobiera dokładnie jedną kartę", () => {
    const deck: Card[] = [c("5"), c("K")];
    const hand: Card[] = [c("7"), c("4")];
    const result = applyDoubleDown(deck, hand);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.playerHand).toHaveLength(3);
      expect(result.value.newCard).toEqual(c("5"));
      expect(result.value.remainingDeck).toHaveLength(1);
    }
  });

  it("zwraca ok:false gdy gracz ma więcej niż 2 karty", () => {
    const deck: Card[] = [c("5")];
    const hand: Card[] = [c("7"), c("4"), c("3")]; // 3 karty
    const result = applyDoubleDown(deck, hand);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_ACTION");
    }
  });

  it("zwraca ok:false gdy talia jest pusta", () => {
    const result = applyDoubleDown([], [c("7"), c("4")]);
    expect(result.ok).toBe(false);
  });
});

// ─── determineResult ──────────────────────────────────────────────────────────

describe("determineResult", () => {
  it("gracz wygrywa wyższą wartością (19 > 17 → WIN)", () => {
    expect(
      determineResult(
        [c("K"), c("9")],    // 19
        [c("K"), c("7")]     // 17
      )
    ).toBe("WIN");
  });

  it("gracz przegrywa niższą wartością (15 < 18 → LOSS)", () => {
    expect(
      determineResult(
        [c("K"), c("5")],    // 15
        [c("K"), c("8")]     // 18
      )
    ).toBe("LOSS");
  });

  it("remis przy równej wartości (18 = 18 → PUSH)", () => {
    expect(
      determineResult(
        [c("K"), c("8")],    // 18
        [c("9"), c("9", "CLUBS")] // 18
      )
    ).toBe("PUSH");
  });

  it("gracz z Blackjackiem wygrywa (BLACKJACK → 3:2)", () => {
    expect(
      determineResult(
        [c("A"), c("K")],    // Blackjack
        [c("K"), c("8")]     // 18
      )
    ).toBe("BLACKJACK");
  });

  it("obaj z Blackjackiem → PUSH", () => {
    expect(
      determineResult(
        [c("A"), c("K")],          // Blackjack
        [c("A", "SPADES"), c("Q")] // Blackjack
      )
    ).toBe("PUSH");
  });

  it("gracz bustuje → LOSS (bez względu na dealera)", () => {
    expect(
      determineResult(
        [c("K"), c("Q"), c("5")], // 25 bust
        [c("K"), c("6")]          // 16
      )
    ).toBe("LOSS");
  });

  it("dealer bustuje → WIN gracza", () => {
    expect(
      determineResult(
        [c("K"), c("8")],          // 18
        [c("K"), c("Q"), c("5")]   // 25 bust
      )
    ).toBe("WIN");
  });

  it("gracz i dealer bustują → LOSS (bust gracza ma pierwszeństwo)", () => {
    expect(
      determineResult(
        [c("K"), c("Q"), c("5")], // 25 bust
        [c("K"), c("Q"), c("5", "CLUBS")] // 25 bust
      )
    ).toBe("LOSS");
  });
});

// ─── calculateChipsDelta ──────────────────────────────────────────────────────

describe("calculateChipsDelta", () => {
  it("WIN → +betAmount", () => {
    expect(calculateChipsDelta("WIN", 100)).toBe(100);
  });

  it("LOSS → -betAmount", () => {
    expect(calculateChipsDelta("LOSS", 100)).toBe(-100);
  });

  it("PUSH → 0 (bez zmiany salda)", () => {
    expect(calculateChipsDelta("PUSH", 100)).toBe(0);
  });

  it("BLACKJACK → +floor(betAmount * 1.5) — wypłata 3:2", () => {
    expect(calculateChipsDelta("BLACKJACK", 100)).toBe(150);
  });

  it("BLACKJACK z zakładem 33 → floor(33 * 1.5) = 49 (nie 49.5)", () => {
    expect(calculateChipsDelta("BLACKJACK", 33)).toBe(49);
  });

  it("null (gra nierozstrzygnięta) → 0", () => {
    expect(calculateChipsDelta(null, 100)).toBe(0);
  });
});

// ─── Pełna rozgrywka end-to-end (deterministyczna) ────────────────────────────

describe("Pełna rozgrywka E2E (deterministyczny seed)", () => {
  it("kompletna sekwencja: createDeck → deal → hit → stand → wynik", () => {
    const deck = createDeck("e2e-test-seed-v1");
    const { playerHand, dealerHand, remainingDeck } = dealInitialCards(deck);

    // Gracz dobiera kartę
    const hitResult = applyHit(remainingDeck, playerHand);
    expect(hitResult.ok).toBe(true);

    if (!hitResult.ok) return;
    const { playerHand: playerAfterHit, remainingDeck: deckAfterHit } =
      hitResult.value;

    // Gracz staje — dealer gra
    const standResult = applyStand(deckAfterHit, dealerHand);
    expect(standResult.ok).toBe(true);

    if (!standResult.ok) return;
    const { dealerHand: finalDealerHand } = standResult.value;

    // Oblicz wynik
    const result = determineResult(playerAfterHit, finalDealerHand);
    expect(["WIN", "LOSS", "PUSH", "BLACKJACK"]).toContain(result);

    // Oblicz zmianę żetonów
    const delta = calculateChipsDelta(result, 50);
    if (result === "WIN") expect(delta).toBe(50);
    else if (result === "BLACKJACK") expect(delta).toBe(75);
    else if (result === "LOSS") expect(delta).toBe(-50);
    else expect(delta).toBe(0);
  });

  it("ta sama rozgrywka z identycznym seedem daje identyczny wynik", () => {
    const runGame = (seed: string) => {
      const deck = createDeck(seed);
      const { playerHand, dealerHand, remainingDeck } = dealInitialCards(deck);
      const standResult = applyStand(remainingDeck, dealerHand);
      if (!standResult.ok) throw new Error("Stand failed");
      return determineResult(playerHand, standResult.value.dealerHand);
    };

    const seed = "reproducible-game-seed";
    expect(runGame(seed)).toBe(runGame(seed));
  });
});
