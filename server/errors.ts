/** An error whose message is meant for the user, with the HTTP status the API should return. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
