# Wicket Event Hardening Design

## Current Risk

The current scoring model stores a wicket inside a projected `balls` row. That is sufficient for simple zero-run wickets, but it is not expressive enough for:

- completed_runs plus a dismissal on the same delivery
- wicket-plus-extras combinations such as run-out with byes or leg-byes
- administrative state changes such as `retired hurt` that should not consume a delivery slot

Those cases are risky because the scorer UI has to infer actor movement and over progression from partial state instead of an explicit event contract.

## Proposed Event Model

Introduce two authoritative event types in `match_session_events`:

1. `delivery_recorded`
2. `administrative_state_changed`

`delivery_recorded` should be the only event that creates or edits a delivery in the `balls` projection.

Suggested payload:

```json
{
  "delivery": {
    "over_no": 12,
    "delivery_in_over": 3,
    "legal_ball": true,
    "striker_id": "uuid",
    "non_striker_id": "uuid",
    "bowler_id": "uuid"
  },
  "scoring": {
    "runs_off_bat": 0,
    "completed_runs": 1,
    "extras": [
      { "type": "bye", "runs": 1 }
    ]
  },
  "dismissals": [
    {
      "kind": "run out",
      "player_id": "uuid",
      "credited_to_ball": true,
      "crossed_before_wicket": false
    }
  ],
  "post_state": {
    "striker_id": "uuid",
    "non_striker_id": "uuid",
    "striker_turn": 1,
    "non_striker_turn": 2,
    "bowler_id": "uuid",
    "needs_next_bowler": false
  }
}
```

`administrative_state_changed` should handle non-delivery transitions:

- `retired hurt`
- batter replacement without a legal delivery
- scorer corrections that only change active actors

Suggested payload:

```json
{
  "reason": "retired hurt",
  "dismissals": [
    {
      "kind": "retired hurt",
      "player_id": "uuid",
      "counts_as_wicket": false
    }
  ],
  "post_state": {
    "striker_id": "uuid",
    "non_striker_id": "uuid",
    "striker_turn": 2,
    "non_striker_turn": 1,
    "bowler_id": "uuid",
    "needs_next_bowler": false
  }
}
```

## Projection Rules

- `balls` remains an ordered projection, not the source of truth.
- `delivery_recorded` creates exactly one projected delivery row keyed by `source_event_id`.
- `administrative_state_changed` never creates a delivery row and therefore never consumes over or ball position.
- `completed_runs` and `extras` are summed independently so wicket-plus-extras can be replayed deterministically.
- `dismissals` is an array so one delivery can represent unusual but valid multiple-dismissal cases without overloading booleans.

## Migration Strategy

1. Add new event payload support in `apply_match_session_event`.
2. Preserve current `add_ball` handling as a compatibility layer that translates into `delivery_recorded`.
3. Replace the current retired-hurt path with `administrative_state_changed`.
4. Only enable wicket-plus-extras UI after replay and projection tests pass against the new event type.

## Required Tests

- replay of `delivery_recorded` with completed_runs and `dismissals`
- replay of wicket-plus-extras combinations
- `administrative_state_changed` does not advance over or delivery position
- refresh recovery restores `post_state` after mixed delivery and administrative events
- edit rules stay fail-closed when downstream actor state cannot be proven
