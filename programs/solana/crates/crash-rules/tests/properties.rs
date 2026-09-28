//! Property tests of the invariants in docs/specs/crash-round-rules.md §9.

use crash_rules::*;
use proptest::prelude::*;

const RULES: Rules = CRASH_RULES_V1;

fn centi(min: u64, max: u64) -> impl Strategy<Value = u64> {
    (min / CENTI_STEP..=max / CENTI_STEP).prop_map(|value| value * CENTI_STEP)
}

fn bet() -> impl Strategy<Value = (u64, Option<u64>, Option<u64>)> {
    (
        0u64..=1_000_000_000_000,
        proptest::option::of(centi(MIN_CASH_OUT_MULTIPLIER, RULES.max_multiplier)),
        proptest::option::of(0u64..196),
    )
        .prop_filter("recorded cash-outs are at least 1.01x", |(_, _, tick)| {
            tick.is_none_or(|tick| {
                RULES.recognized_at_tick(tick).unwrap() >= MIN_CASH_OUT_MULTIPLIER
            })
        })
}

proptest! {
    #[test]
    fn crash_points_are_centi_precise_and_bounded(uniform in 0u64..UNIFORM_RANGE) {
        let crash_point = RULES.crash_point_from_uniform(uniform).unwrap();
        prop_assert!(is_centi_precise(crash_point));
        prop_assert!((MULTIPLIER_SCALE..=RULES.max_multiplier).contains(&crash_point));
    }

    #[test]
    fn payout_is_zero_or_within_stake_and_exposure(
        (stake, auto, tick) in bet(),
        crash_point in centi(MULTIPLIER_SCALE, RULES.max_multiplier),
    ) {
        let payout = settle_bet(&RULES, stake, auto, tick, crash_point).unwrap().payout();
        let exposure = bet_exposure(stake, auto, RULES.max_multiplier).unwrap();
        prop_assert!(payout == 0 || (stake..=exposure).contains(&payout));
    }

    #[test]
    fn winning_multiplier_respects_the_single_rule(
        (stake, auto, tick) in bet(),
        crash_point in centi(MULTIPLIER_SCALE, RULES.max_multiplier),
    ) {
        if let Outcome::CashedOut { multiplier, .. } = settle_bet(&RULES, stake, auto, tick, crash_point).unwrap() {
            prop_assert!(multiplier >= MIN_CASH_OUT_MULTIPLIER && multiplier <= crash_point);
            if let Some(target) = auto.filter(|target| *target <= crash_point) {
                prop_assert!(multiplier <= target);
            }
        }
    }

    #[test]
    fn higher_crash_point_never_lowers_the_payout(
        (stake, auto, tick) in bet(),
        first in centi(MULTIPLIER_SCALE, RULES.max_multiplier),
        second in centi(MULTIPLIER_SCALE, RULES.max_multiplier),
    ) {
        let (low, high) = if first <= second { (first, second) } else { (second, first) };
        let low_payout = settle_bet(&RULES, stake, auto, tick, low).unwrap().payout();
        let high_payout = settle_bet(&RULES, stake, auto, tick, high).unwrap().payout();
        prop_assert!(high_payout >= low_payout);
    }

    #[test]
    fn forfeit_never_costs_the_house_less_than_revealing(
        (stake, auto, tick) in bet(),
        crash_point in centi(MULTIPLIER_SCALE, RULES.max_multiplier),
    ) {
        let forfeited = settle_forfeited_bet(&RULES, stake, auto, tick).unwrap().payout();
        let revealed = settle_bet(&RULES, stake, auto, tick, crash_point).unwrap().payout();
        prop_assert!(forfeited >= revealed);
        prop_assert!(forfeited <= bet_exposure(stake, auto, RULES.max_multiplier).unwrap());
    }
}

#[test]
fn rules_registry_knows_only_published_versions() {
    assert_eq!(rules_for_version(1), Some(CRASH_RULES_V1));
    assert_eq!(rules_for_version(0), None);
    assert_eq!(rules_for_version(2), None);
}

#[test]
fn invalid_rules_are_rejected() {
    let invalid = [
        Rules {
            house_edge_bps: MULTIPLIER_SCALE,
            ..RULES
        },
        Rules {
            growth_ppm: MIN_GROWTH_PPM - 1,
            ..RULES
        },
        Rules {
            max_multiplier: 10_050,
            ..RULES
        },
        Rules {
            max_multiplier: MAX_SUPPORTED_MULTIPLIER + CENTI_STEP,
            ..RULES
        },
    ];
    for rules in invalid {
        assert_eq!(rules.validate(), Err(RulesError::InvalidRules));
    }
}

#[test]
fn payout_overflow_is_reported() {
    assert_eq!(
        payout_for(u64::MAX, 20_000),
        Err(RulesError::ArithmeticOverflow)
    );
}
