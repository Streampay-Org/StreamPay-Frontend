import {
  signTransactionSafe,
  CancellationError,
  ValidationError,
  ConcurrentSigningError,
  _resetSigningState,
} from "./wallet-signing";

describe("Wallet Transaction Signing", () => {
  beforeEach(() => {
    _resetSigningState();
  });

  it("should successfully sign a transaction", async () => {
    const mockSignFn = jest.fn().mockResolvedValue("signed-xdr");
    const result = await signTransactionSafe("valid-xdr", mockSignFn);
    expect(result).toBe("signed-xdr");
    expect(mockSignFn).toHaveBeenCalledWith("valid-xdr");
  });

  it("should throw ValidationError if xdr is invalid", async () => {
    const mockSignFn = jest.fn();
    await expect(signTransactionSafe("", mockSignFn)).rejects.toThrow(ValidationError);
    await expect(signTransactionSafe("   ", mockSignFn)).rejects.toThrow(ValidationError);
    expect(mockSignFn).not.toHaveBeenCalled();
  });

  it("should prevent concurrent signing requests", async () => {
    const mockSignFn = jest.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("signed-xdr"), 100))
    );

    const firstRequest = signTransactionSafe("valid-xdr-1", mockSignFn);
    
    await expect(signTransactionSafe("valid-xdr-2", mockSignFn)).rejects.toThrow(ConcurrentSigningError);
    
    await firstRequest; // wait for the first one to finish
  });

  it("should handle AbortSignal cancellation before signing starts", async () => {
    const controller = new AbortController();
    controller.abort();
    
    const mockSignFn = jest.fn();
    await expect(signTransactionSafe("valid-xdr", mockSignFn, controller.signal)).rejects.toThrow(CancellationError);
    expect(mockSignFn).not.toHaveBeenCalled();
  });

  it("should handle AbortSignal cancellation during signing", async () => {
    const controller = new AbortController();
    
    const mockSignFn = jest.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("signed-xdr"), 100))
    );

    const promise = signTransactionSafe("valid-xdr", mockSignFn, controller.signal);
    controller.abort();
    
    await expect(promise).rejects.toThrow(CancellationError);
  });

  it("should translate 'user declined' errors to CancellationError", async () => {
    const mockSignFn = jest.fn().mockRejectedValue(new Error("User declined request"));
    
    await expect(signTransactionSafe("valid-xdr", mockSignFn)).rejects.toThrow(CancellationError);
  });

  it("should pass through other unexpected errors", async () => {
    const mockSignFn = jest.fn().mockRejectedValue(new Error("Network Error"));
    
    await expect(signTransactionSafe("valid-xdr", mockSignFn)).rejects.toThrow("Network Error");
  });

  it("should clear the signing lock after a successful signature", async () => {
    const mockSignFn = jest.fn().mockResolvedValue("signed-xdr");
    
    await signTransactionSafe("valid-xdr", mockSignFn);
    
    // The second request should succeed, not throw ConcurrentSigningError
    const result2 = await signTransactionSafe("valid-xdr-2", mockSignFn);
    expect(result2).toBe("signed-xdr");
  });

  it("should clear the signing lock after a rejection", async () => {
    const mockSignFn = jest.fn().mockRejectedValue(new Error("User declined"));
    
    await expect(signTransactionSafe("valid-xdr", mockSignFn)).rejects.toThrow(CancellationError);
    
    // The second request should succeed
    const mockSuccessFn = jest.fn().mockResolvedValue("signed-xdr");
    const result = await signTransactionSafe("valid-xdr-2", mockSuccessFn);
    expect(result).toBe("signed-xdr");
  });
});
