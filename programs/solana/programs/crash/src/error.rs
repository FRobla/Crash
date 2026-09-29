use anchor_lang::prelude::*;

#[error_code]
pub enum CrashError {
    #[msg("Invalid house configuration")]
    InvalidConfig,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("The house is paused")]
    Paused,
    #[msg("Another round is still active")]
    RoundStillActive,
    #[msg("The commitment must not be empty")]
    EmptyCommitment,
    #[msg("The round is not in the required phase")]
    InvalidPhase,
    #[msg("The betting window has closed")]
    BettingClosed,
    #[msg("The betting window is still open")]
    BettingStillOpen,
    #[msg("Stake is below the minimum")]
    StakeBelowMinimum,
    #[msg("Stake is above the maximum")]
    StakeAboveMaximum,
    #[msg("Auto cash-out must be a multiple of 0.01x")]
    AutoCashOutNotCentiPrecise,
    #[msg("Auto cash-out is below 1.01x")]
    AutoCashOutBelowMinimum,
    #[msg("Auto cash-out is above the maximum multiplier")]
    AutoCashOutAboveMaximum,
    #[msg("Potential payout is above the maximum")]
    PayoutAboveMaximum,
    #[msg("The round exposure limit would be exceeded")]
    RoundExposureExceeded,
    #[msg("The round has reached its maximum number of bets")]
    TooManyBets,
    #[msg("The house bank cannot cover this bet")]
    InsufficientBank,
    #[msg("Withdrawal would leave reserved exposure uncovered")]
    WithdrawalExceedsAvailable,
    #[msg("The player has no bet in play")]
    NoActiveBet,
    #[msg("The player already has a bet in play; settle it first")]
    ActiveBetPending,
    #[msg("The bet in play belongs to another round")]
    BetRoundMismatch,
    #[msg("The bet already has a cash-out")]
    AlreadyCashedOut,
    #[msg("Cash-out is below 1.01x")]
    CashOutTooEarly,
    #[msg("The round horizon has been exceeded")]
    RoundHorizonExceeded,
    #[msg("The revealed seed does not match the commitment")]
    CommitmentMismatch,
    #[msg("The curve has not reached the crash point yet")]
    RevealTooEarly,
    #[msg("The reveal deadline has passed; only forfeit applies")]
    RevealDeadlinePassed,
    #[msg("The deadline has not passed yet")]
    DeadlineNotReached,
    #[msg("Only the operator can do this in the current phase")]
    OperatorRequired,
    #[msg("The house randomness account is not configured")]
    RandomnessNotConfigured,
    #[msg("The randomness account is not a Switchboard account controlled by this program")]
    InvalidRandomnessAccount,
    #[msg("The randomness does not belong to this round's commit or was not just revealed")]
    StaleRandomness,
    #[msg("The entropy deadline has passed; only void applies")]
    EntropyDeadlinePassed,
    #[msg("Usernames must be 3-16 characters in [a-z0-9_]")]
    InvalidUsername,
    #[msg("The username was changed too recently")]
    UsernameCooldown,
    #[msg("The username record does not match the player's current name")]
    UsernameRecordMismatch,
    #[msg("The signer is neither the player nor a session allowed to do this")]
    Unauthorized,
    #[msg("The session has expired")]
    SessionExpired,
    #[msg("The session spend cap would be exceeded")]
    SessionSpendCapExceeded,
    #[msg("Invalid session key, expiry or spend cap")]
    InvalidSession,
    #[msg("The player has no session")]
    NoSession,
    #[msg("The player balance is insufficient")]
    InsufficientBalance,
    #[msg("The player still has a balance or a bet in play")]
    PlayerNotEmpty,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Rules error")]
    RulesError,
}

impl From<crash_rules::BetRejection> for CrashError {
    fn from(rejection: crash_rules::BetRejection) -> Self {
        use crash_rules::BetRejection::*;
        match rejection {
            StakeBelowMinimum => CrashError::StakeBelowMinimum,
            StakeAboveMaximum => CrashError::StakeAboveMaximum,
            AutoCashOutNotCentiPrecise => CrashError::AutoCashOutNotCentiPrecise,
            AutoCashOutBelowMinimum => CrashError::AutoCashOutBelowMinimum,
            AutoCashOutAboveMaximum => CrashError::AutoCashOutAboveMaximum,
            PayoutAboveMaximum => CrashError::PayoutAboveMaximum,
        }
    }
}

impl From<crash_rules::RulesError> for CrashError {
    fn from(error: crash_rules::RulesError) -> Self {
        match error {
            crash_rules::RulesError::ArithmeticOverflow => CrashError::ArithmeticOverflow,
            crash_rules::RulesError::TickOutsideHorizon => CrashError::RoundHorizonExceeded,
            _ => CrashError::RulesError,
        }
    }
}
