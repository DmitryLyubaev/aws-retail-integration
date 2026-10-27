# Synthetic sale contract

`SaleCompleted`, schema version 1, represents a completed fictional AUD sale. There is
no tax calculation or payment processing. Quantities are positive safe integers; unit
amounts and totals are positive base-10 minor-unit strings without leading zeroes,
limited to twelve digits. Line totals use bigint arithmetic.

Each body is at most 65,536 bytes and has one to twenty lines. Event IDs and sale
references are 1-128 ASCII letters/digits or `._:-`, starting with a letter/digit.
SKUs have 1-64 UTF-16 code units and no ASCII control characters. Unknown properties
at either object level are rejected. UTC timestamps require `Z`, valid calendar values
and at most three fractional digits, normalised to millisecond ISO format.

The original accepted bytes and hash remain immutable. Business identity includes the
sale reference, normalised occurrence time, currency, ordered line items and total.
Object property order and whitespace do not affect its digest. Transport event IDs
are excluded, allowing aliases to reference the same sale without another effect.

The receiver is cooperative and retains its receipt for the dataset lifetime. Repeated
network delivery remains possible. Demonstrated duplicate protection is conditional on
retaining that receiver identity and receipt, not an exactly-once transport guarantee.
