using System;
using Vintagestory.API.Common;
using Vintagestory.API.MathTools;
using Vintagestory.API.Server;

namespace MyMod;

// Your main mod inherits from regular ModSystem, as usual
public class MyModSystem : ModSystem
{
    public void TurnIntoDrifter(IServerPlayer player)
    {
        try
        {
            if (!PositionIsNearbyEnough(player.Entity.Pos.AsBlockPos, new BlockPos(0, 0, 0)))
                DoMagic();
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("wat?", ex);
        }
    }

    public static void DoMagic()
    {
        throw new NotImplementedException("magic not implemented yet");
    }

    public static bool PositionIsNearbyEnough(BlockPos pos1, BlockPos pos2, float maxDistance = 10)
    {
        return pos1.DistanceTo(pos2) < maxDistance;
    }
}
