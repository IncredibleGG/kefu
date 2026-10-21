import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/api/client";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, err) => {
        // 認證錯誤不重試
        if (err instanceof ApiError && err.httpStatus === 401) return false;
        return count < 1;
      },
      refetchOnWindowFocus: false,
    },
  },
});
