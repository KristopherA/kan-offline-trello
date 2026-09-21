import { TRPCError } from "@trpc/server";
import { z } from "zod";

import * as feedbackRepo from "@kan/db/repository/feedback.repo";

import { createTRPCRouter, protectedProcedure } from "../trpc";

export const feedbackRouter = createTRPCRouter({
  create: protectedProcedure
    .meta({
      enabled: false,
      openapi: { enabled: false, method: "POST", path: "/feedback" },
    })
    .input(
      z.object({
        feedback: z.string().min(1),
        url: z.string().min(1),
      }),
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;

      if (!userId)
        throw new TRPCError({
          message: `User not authenticated`,
          code: "UNAUTHORIZED",
        });

      const result = await feedbackRepo.create(ctx.db, {
        feedback: input.feedback,
        createdBy: userId,
        url: input.url,
      });

      if (!result?.id)
        throw new TRPCError({
          message: `Unable to create workspace`,
          code: "INTERNAL_SERVER_ERROR",
        });

      return { success: true };
    }),
});
