export class DomainError extends Error {
  constructor(
    public code: string,
    public status: number,
    message = code,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
