//! Pure Crash rules, mirroring `src/games/crash/domain` (spec: docs/specs/crash-round-rules.md).
//!
//! No Anchor, no Solana types, no allocation, no clock and no randomness: the same inputs always
//! produce the same outputs. Conformance is checked against docs/specs/vectors/crash-rules-v<N>.json.

#![cfg_attr(not(test), no_std)]

/// `1.0000x` in ten-thousandths.
pub const MULTIPLIER_SCALE: u64 = 10_000;
/// One hundredth of a multiplier (0.01x), the recognized precision.
pub const CENTI_STEP: u64 = 100;
/// Lowest multiplier at which any cash-out can be recognized (1.01x).
pub const MIN_CASH_OUT_MULTIPLIER: u64 = 10_100;
/// Upper bound for a configurable `max_multiplier` (1,000,000x).
pub const MAX_SUPPORTED_MULTIPLIER: u64 = 1_000_000 * MULTIPLIER_SCALE;
pub const MIN_GROWTH_PPM: u64 = 1_000;
pub const MAX_GROWTH_PPM: u64 = 1_000_000;
pub const ENTROPY_BYTES: usize = 32;
pub const UNIFORM_BITS: u32 = 52;
pub const UNIFORM_RANGE: u64 = 1 << UNIFORM_BITS;
const PPM: u64 = 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RulesError {
    InvalidRules,
    TickOutsideHorizon,
    MultiplierOutOfRange,
    UniformOutOfRange,
    ArithmeticOverflow,
}

/// An immutable, versioned rule set (spec §5.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rules {
    pub version: u16,
    pub house_edge_bps: u64,
    pub growth_ppm: u64,
    pub max_multiplier: u64,
}

/// Approved for devnet only; requires a risk review before real funds.
pub const CRASH_RULES_V1: Rules = Rules {
    version: 1,
    house_edge_bps: 300,
    growth_ppm: 24_000,
    max_multiplier: 1_000_000,
};

pub fn rules_for_version(version: u16) -> Option<Rules> {
    match version {
        1 => Some(CRASH_RULES_V1),
        _ => None,
    }
}

pub const fn truncate_to_centi(multiplier: u64) -> u64 {
    (multiplier / CENTI_STEP) * CENTI_STEP
}

pub const fn is_centi_precise(multiplier: u64) -> bool {
    multiplier.is_multiple_of(CENTI_STEP)
}

/// `⌊stake · multiplier / 10_000⌋`; truncation favors the house by at most one base unit.
pub fn payout_for(stake: u64, multiplier: u64) -> Result<u64, RulesError> {
    let payout = (stake as u128) * (multiplier as u128) / (MULTIPLIER_SCALE as u128);
    u64::try_from(payout).map_err(|_| RulesError::ArithmeticOverflow)
}

impl Rules {
    pub fn validate(&self) -> Result<(), RulesError> {
        let valid = self.house_edge_bps < MULTIPLIER_SCALE
            && (MIN_GROWTH_PPM..=MAX_GROWTH_PPM).contains(&self.growth_ppm)
            && is_centi_precise(self.max_multiplier)
            && (MIN_CASH_OUT_MULTIPLIER..=MAX_SUPPORTED_MULTIPLIER).contains(&self.max_multiplier);
        if valid {
            Ok(())
        } else {
            Err(RulesError::InvalidRules)
        }
    }

    fn next_point(&self, multiplier: u64) -> Result<u64, RulesError> {
        let growth = (multiplier as u128) * (self.growth_ppm as u128) / (PPM as u128);
        u64::try_from(multiplier as u128 + growth).map_err(|_| RulesError::ArithmeticOverflow)
    }

    /// Number of curve points: up to and including the first tick whose recognized multiplier
    /// exceeds `max_multiplier` (spec §4). 196 for v1.
    pub fn horizon(&self) -> Result<u64, RulesError> {
        self.validate()?;
        let mut multiplier = MULTIPLIER_SCALE;
        let mut ticks = 1;
        while truncate_to_centi(multiplier) <= self.max_multiplier {
            multiplier = self.next_point(multiplier)?;
            ticks += 1;
        }
        Ok(ticks)
    }

    /// Raw multiplier at `tick`: `m₀ = 1.0000x`, `mₙ₊₁ = mₙ + ⌊mₙ · growth_ppm / 10⁶⌋`.
    pub fn multiplier_at_tick(&self, tick: u64) -> Result<u64, RulesError> {
        self.validate()?;
        let mut multiplier = MULTIPLIER_SCALE;
        for _ in 0..tick {
            // A point exists only while every earlier point is within the maximum.
            if truncate_to_centi(multiplier) > self.max_multiplier {
                return Err(RulesError::TickOutsideHorizon);
            }
            multiplier = self.next_point(multiplier)?;
        }
        Ok(multiplier)
    }

    pub fn recognized_at_tick(&self, tick: u64) -> Result<u64, RulesError> {
        self.multiplier_at_tick(tick).map(truncate_to_centi)
    }

    /// First tick whose recognized multiplier is `> crash_point`: the round is over from there on.
    pub fn crash_tick(&self, crash_point: u64) -> Result<u64, RulesError> {
        self.first_tick_where(crash_point, |recognized| recognized > crash_point)
    }

    /// First tick whose recognized multiplier is `>= target`.
    pub fn first_tick_at_least(&self, target: u64) -> Result<u64, RulesError> {
        self.first_tick_where(target, |recognized| recognized >= target)
    }

    fn first_tick_where(
        &self,
        bound: u64,
        predicate: impl Fn(u64) -> bool,
    ) -> Result<u64, RulesError> {
        self.validate()?;
        if bound < MULTIPLIER_SCALE || bound > self.max_multiplier {
            return Err(RulesError::MultiplierOutOfRange);
        }
        let mut multiplier = MULTIPLIER_SCALE;
        let mut tick = 0;
        // Terminates: the recognized curve strictly exceeds `max_multiplier >= bound` at the horizon.
        while !predicate(truncate_to_centi(multiplier)) {
            multiplier = self.next_point(multiplier)?;
            tick += 1;
        }
        Ok(tick)
    }

    /// Crash point from a uniform `r ∈ [0, 2⁵²)` (spec §5).
    pub fn crash_point_from_uniform(&self, uniform: u64) -> Result<u64, RulesError> {
        self.validate()?;
        if uniform >= UNIFORM_RANGE {
            return Err(RulesError::UniformOutOfRange);
        }
        let numerator =
            ((MULTIPLIER_SCALE - self.house_edge_bps) as u128) * (UNIFORM_RANGE as u128);
        let denominator = (CENTI_STEP as u128) * ((UNIFORM_RANGE - uniform) as u128);
        let raw_centi = numerator / denominator;
        let centi = raw_centi.max(CENTI_STEP as u128);
        let crash_point = centi * CENTI_STEP as u128;
        Ok(crash_point.min(self.max_multiplier as u128) as u64)
    }

    pub fn crash_point_from_entropy(
        &self,
        entropy: &[u8; ENTROPY_BYTES],
    ) -> Result<u64, RulesError> {
        self.crash_point_from_uniform(uniform_from_entropy(entropy))
    }
}

/// The first 52 bits of the entropy, big-endian.
pub fn uniform_from_entropy(entropy: &[u8; ENTROPY_BYTES]) -> u64 {
    let mut value: u64 = 0;
    for byte in &entropy[..7] {
        value = (value << 8) | *byte as u64;
    }
    value >> 4
}

/// Per-asset limits (spec §7), in base units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BetLimits {
    pub min_stake: u64,
    pub max_stake: u64,
    pub max_payout: u64,
    pub max_round_exposure: u64,
}

impl BetLimits {
    pub fn is_valid(&self) -> bool {
        self.min_stake >= 1 && self.max_stake >= self.min_stake
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BetRejection {
    StakeBelowMinimum,
    StakeAboveMaximum,
    AutoCashOutNotCentiPrecise,
    AutoCashOutBelowMinimum,
    AutoCashOutAboveMaximum,
    PayoutAboveMaximum,
}

/// Largest payout a bet can receive under any settlement, including a forfeit.
pub fn bet_exposure(
    stake: u64,
    auto_cash_out: Option<u64>,
    max_multiplier: u64,
) -> Result<u64, RulesError> {
    payout_for(stake, auto_cash_out.unwrap_or(max_multiplier))
}

/// Checks a bet against the per-asset limits; on success returns its exposure.
pub fn validate_bet(
    stake: u64,
    auto_cash_out: Option<u64>,
    limits: &BetLimits,
    max_multiplier: u64,
) -> Result<u64, BetRejection> {
    if stake < limits.min_stake {
        return Err(BetRejection::StakeBelowMinimum);
    }
    if stake > limits.max_stake {
        return Err(BetRejection::StakeAboveMaximum);
    }
    if let Some(target) = auto_cash_out {
        if !is_centi_precise(target) {
            return Err(BetRejection::AutoCashOutNotCentiPrecise);
        }
        if target < MIN_CASH_OUT_MULTIPLIER {
            return Err(BetRejection::AutoCashOutBelowMinimum);
        }
        if target > max_multiplier {
            return Err(BetRejection::AutoCashOutAboveMaximum);
        }
    }
    match bet_exposure(stake, auto_cash_out, max_multiplier) {
        Ok(exposure) if exposure <= limits.max_payout => Ok(exposure),
        _ => Err(BetRejection::PayoutAboveMaximum),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    CashedOut { multiplier: u64, payout: u64 },
    Lost,
    Refunded { payout: u64 },
}

impl Outcome {
    pub fn payout(&self) -> u64 {
        match *self {
            Outcome::CashedOut { payout, .. } | Outcome::Refunded { payout } => payout,
            Outcome::Lost => 0,
        }
    }
}

/// Settles one bet of a revealed round (spec §6.1). `cash_out_tick` is the authoritative tick of
/// the bet's first accepted manual cash-out, if any.
pub fn settle_bet(
    rules: &Rules,
    stake: u64,
    auto_cash_out: Option<u64>,
    cash_out_tick: Option<u64>,
    crash_point: u64,
) -> Result<Outcome, RulesError> {
    let end_tick = rules.crash_tick(crash_point)?;

    let auto = match auto_cash_out {
        Some(target) if target <= crash_point => Some((rules.first_tick_at_least(target)?, target)),
        _ => None,
    };
    let manual = match cash_out_tick {
        Some(tick) if tick < end_tick => {
            let multiplier = rules.recognized_at_tick(tick)?;
            (multiplier >= MIN_CASH_OUT_MULTIPLIER).then_some((tick, multiplier))
        }
        _ => None,
    };
    // Earliest tick wins; on a tie the auto cash-out precedes the manual one.
    let winner = match (manual, auto) {
        (Some(manual), Some(auto)) => Some(if manual.0 < auto.0 { manual } else { auto }),
        (manual, auto) => manual.or(auto),
    };

    Ok(match winner {
        Some((_, multiplier)) => Outcome::CashedOut {
            multiplier,
            payout: payout_for(stake, multiplier)?,
        },
        None => Outcome::Lost,
    })
}

/// A forfeited round (spec §6.4): settled at `max_multiplier`; a losing bet is refunded instead.
pub fn settle_forfeited_bet(
    rules: &Rules,
    stake: u64,
    auto_cash_out: Option<u64>,
    cash_out_tick: Option<u64>,
) -> Result<Outcome, RulesError> {
    Ok(
        match settle_bet(
            rules,
            stake,
            auto_cash_out,
            cash_out_tick,
            rules.max_multiplier,
        )? {
            Outcome::Lost => Outcome::Refunded { payout: stake },
            outcome => outcome,
        },
    )
}

/// A voided round (spec §6.3): the stake is refunded exactly.
pub fn refund_bet(stake: u64) -> Outcome {
    Outcome::Refunded { payout: stake }
}
