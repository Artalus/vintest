using System;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Vintagestory.API.MathTools;

namespace MyMod.unittests;

[TestClass]
public class TestMagic
{
    [TestMethod]
    public void DoMagic_Throws()
    {
        Assert.Throws<Exception>(() => MyModSystem.DoMagic());
    }
}

[TestClass]
public class TestPositionIsNearby
{
    [TestMethod]
    public void SameCoordsAreNearby()
    {
        var pos1 = new BlockPos(0, 0, 0);
        var pos2 = new BlockPos(0, 0, 0);
        Assert.IsTrue(MyModSystem.PositionIsNearbyEnough(pos1, pos2));
    }
}
