# Public RDS trust roots

Downloaded 27 October 2026 from the official
[Sydney CA bundle](https://truststore.pki.rds.amazonaws.com/ap-southeast-2/ap-southeast-2-bundle.pem).
SHA-256: `d73890748b5a95551800df8a6f07c9c800e32ed34da7e6c9505918bf8ac2398b`.
The offline check parses three root CA certificates and checks each is a CA with
identical subject/issuer. AWS database URLs require `sslmode=verify-full` and this
bundle path; the maintenance process builds its URL from injected master-secret
parts. Recheck the bundle and supported CA during live preflight, following the
[RDS TLS guide](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html).
This public trust material contains no account credentials.
